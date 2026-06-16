import { z } from "zod";

const CHUNK_BYTES = 100 * 1024;
const MAX_KEYS_PER_OPERATION = 128;
const FORMAT = "chunked-json-v1";

const ChunkManifestSchema = z.object({
	format: z.literal(FORMAT),
	generation: z.number().int().nonnegative(),
	chunks: z.number().int().positive(),
});

type ChunkManifest = z.infer<typeof ChunkManifestSchema>;

export interface ChunkedValueStorage {
	get(key: string): Promise<unknown>;
	getMany(keys: string[]): Promise<Map<string, unknown>>;
	putMany(entries: Record<string, unknown>): Promise<void>;
	deleteMany(keys: string[]): Promise<void>;
}

/**
 * Adapts Durable Object storage to the minimal interface used for chunked values.
 */
export function chunkedDurableObjectStorage(
	storage: DurableObjectStorage,
): ChunkedValueStorage {
	return {
		get: (key) => storage.get(key, { noCache: true }),
		getMany: (keys) => storage.get(keys, { noCache: true }),
		putMany: (entries) => storage.put(entries, { noCache: true }),
		deleteMany: async (keys) => {
			await storage.delete(keys);
		},
	};
}

function parseManifest(value: unknown): ChunkManifest | undefined {
	const result = ChunkManifestSchema.safeParse(value);
	return result.success ? result.data : undefined;
}

function chunkKey(baseKey: string, generation: number, index: number): string {
	return `${baseKey}:chunk:${generation}:${index}`;
}

function pendingKey(baseKey: string, generation: number): string {
	return `${baseKey}:pending:${generation}`;
}

function chunkKeys(baseKey: string, manifest: ChunkManifest): string[] {
	return Array.from({ length: manifest.chunks }, (_, index) =>
		chunkKey(baseKey, manifest.generation, index),
	);
}

function batches<T>(items: T[]): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < items.length; index += MAX_KEYS_PER_OPERATION) {
		result.push(items.slice(index, index + MAX_KEYS_PER_OPERATION));
	}
	return result;
}

async function cleanupPendingGeneration(
	storage: ChunkedValueStorage,
	baseKey: string,
	generation: number,
): Promise<void> {
	const key = pendingKey(baseKey, generation);
	const pending = parseManifest(await storage.get(key));
	if (pending === undefined) {
		return;
	}
	for (const keyBatch of batches(chunkKeys(baseKey, pending))) {
		await storage.deleteMany(keyBatch);
	}
	await storage.deleteMany([key]);
}

/**
 * Loads a value written by saveChunkedValue, or a legacy unchunked value.
 */
export async function loadChunkedValue<T>(
	storage: ChunkedValueStorage,
	baseKey: string,
	schema: z.ZodType<T>,
): Promise<T | undefined> {
	const stored = await storage.get(baseKey);
	if (stored === undefined) {
		return undefined;
	}
	const manifest = parseManifest(stored);
	if (manifest === undefined) {
		return schema.parse(stored);
	}

	const keys = chunkKeys(baseKey, manifest);
	const values = new Map<string, unknown>();
	for (const keyBatch of batches(keys)) {
		const batchValues = await storage.getMany(keyBatch);
		for (const [key, value] of batchValues) {
			values.set(key, value);
		}
	}

	const chunks = keys.map((key) => {
		const value = values.get(key);
		if (!(value instanceof Uint8Array)) {
			throw new Error(`Missing state chunk: ${key}`);
		}
		return value;
	});
	const byteLength = chunks.reduce(
		(total, chunk) => total + chunk.byteLength,
		0,
	);
	const serialized = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		serialized.set(chunk, offset);
		offset += chunk.byteLength;
	}

	const parsed: unknown = JSON.parse(new TextDecoder().decode(serialized));
	return schema.parse(parsed);
}

/**
 * Persists a value as independently bounded chunks. A generation manifest is
 * switched only after all new chunks exist, so readers never observe a partial
 * write. Values written by older versions are migrated on the next save.
 */
export async function saveChunkedValue(
	storage: ChunkedValueStorage,
	baseKey: string,
	value: unknown,
): Promise<void> {
	const previous = await storage.get(baseKey);
	const previousManifest = parseManifest(previous);
	const generation = previousManifest?.generation === 0 ? 1 : 0;
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new TypeError("Chunked storage value must be JSON serializable");
	}
	const serialized = new TextEncoder().encode(json);

	if (serialized.byteLength <= CHUNK_BYTES) {
		if (previousManifest === undefined) {
			await cleanupPendingGeneration(storage, baseKey, 0);
			await cleanupPendingGeneration(storage, baseKey, 1);
		} else {
			await storage.putMany({
				[pendingKey(baseKey, previousManifest.generation)]: previousManifest,
			});
		}
		await storage.putMany({ [baseKey]: value });
		if (previousManifest !== undefined) {
			await cleanupPendingGeneration(
				storage,
				baseKey,
				previousManifest.generation,
			);
		}
		return;
	}

	const nextManifest: ChunkManifest = {
		format: FORMAT,
		generation,
		chunks: Math.ceil(serialized.byteLength / CHUNK_BYTES),
	};
	const nextPendingKey = pendingKey(baseKey, generation);
	await cleanupPendingGeneration(storage, baseKey, generation);

	// Record both generations before writing chunks. If any later write or
	// cleanup fails, the next attempt can remove all abandoned values safely.
	await storage.putMany({
		[nextPendingKey]: nextManifest,
		...(previousManifest === undefined
			? {}
			: {
					[pendingKey(baseKey, previousManifest.generation)]: previousManifest,
				}),
	});

	for (
		let firstChunk = 0;
		firstChunk < nextManifest.chunks;
		firstChunk += MAX_KEYS_PER_OPERATION
	) {
		const entries: Record<string, unknown> = {};
		const lastChunk = Math.min(
			firstChunk + MAX_KEYS_PER_OPERATION,
			nextManifest.chunks,
		);
		for (let index = firstChunk; index < lastChunk; index++) {
			entries[chunkKey(baseKey, generation, index)] = serialized.slice(
				index * CHUNK_BYTES,
				(index + 1) * CHUNK_BYTES,
			);
		}
		await storage.putMany(entries);
	}

	await storage.putMany({ [baseKey]: nextManifest });

	if (previousManifest !== undefined) {
		await cleanupPendingGeneration(
			storage,
			baseKey,
			previousManifest.generation,
		);
	}
	await storage.deleteMany([nextPendingKey]);
}
