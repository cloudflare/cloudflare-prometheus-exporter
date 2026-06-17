import { z } from "zod";

const CHUNK_BYTES = 100 * 1024;
const MAX_KEYS_PER_OPERATION = 128;
const MAX_SERIALIZED_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_SERIALIZED_BYTES / CHUNK_BYTES);
const FORMAT = "chunked-json-v1";

const ChunkManifestSchema = z.object({
	format: z.literal(FORMAT),
	generation: z.union([z.literal(0), z.literal(1)]),
	chunks: z.number().int().positive().max(MAX_CHUNKS),
	bytes: z.number().int().positive().max(MAX_SERIALIZED_BYTES).optional(),
});

type ChunkManifest = z.infer<typeof ChunkManifestSchema>;

export interface ChunkedValueStorage {
	get(key: string): Promise<unknown>;
	getMany(keys: string[]): Promise<Map<string, unknown>>;
	putMany(entries: Record<string, unknown>): Promise<void>;
	deleteMany(keys: string[]): Promise<void>;
}

/** Adapts Durable Object storage to the minimal chunked-value interface. */
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

function manifestKey(baseKey: string): string {
	return `${baseKey}:manifest`;
}

function isChunkFormat(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"format" in value &&
		value.format === FORMAT
	);
}

function parseManifest(value: unknown): ChunkManifest | undefined {
	if (!isChunkFormat(value)) return undefined;
	return ChunkManifestSchema.parse(value);
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
	const stored = await storage.get(key);
	if (stored === undefined) return;
	const pending = ChunkManifestSchema.parse(stored);
	for (const keyBatch of batches(chunkKeys(baseKey, pending))) {
		await storage.deleteMany(keyBatch);
	}
	await storage.deleteMany([key]);
}

async function readCurrentValues(
	storage: ChunkedValueStorage,
	baseKey: string,
): Promise<{ base: unknown; manifest: ChunkManifest | undefined }> {
	const pointerKey = manifestKey(baseKey);
	const values = await storage.getMany([baseKey, pointerKey]);
	const pointer = values.get(pointerKey);
	if (pointer !== undefined) {
		return {
			base: values.get(baseKey),
			manifest: ChunkManifestSchema.parse(pointer),
		};
	}
	const base = values.get(baseKey);
	return { base, manifest: parseManifest(base) };
}

/** Loads a chunked value, or state written by an older unchunked exporter. */
export async function loadChunkedValue<T>(
	storage: ChunkedValueStorage,
	baseKey: string,
	schema: z.ZodType<T>,
): Promise<T | undefined> {
	const current = await readCurrentValues(storage, baseKey);
	if (current.manifest === undefined) {
		return current.base === undefined ? undefined : schema.parse(current.base);
	}

	const decoder = new TextDecoder();
	const keys = chunkKeys(baseKey, current.manifest);
	let serialized = "";
	let byteLength = 0;
	for (const keyBatch of batches(keys)) {
		const values = await storage.getMany(keyBatch);
		for (const key of keyBatch) {
			const value = values.get(key);
			if (!(value instanceof Uint8Array)) {
				throw new Error(`Missing state chunk: ${key}`);
			}
			byteLength += value.byteLength;
			if (byteLength > MAX_SERIALIZED_BYTES) {
				throw new RangeError(
					"Chunked storage value exceeds the safe size limit",
				);
			}
			serialized += decoder.decode(value, { stream: true });
		}
	}
	serialized += decoder.decode();
	if (
		current.manifest.bytes !== undefined &&
		byteLength !== current.manifest.bytes
	) {
		throw new Error("Chunked storage value has an invalid byte length");
	}

	const parsed: unknown = JSON.parse(serialized);
	return schema.parse(parsed);
}

/**
 * Persists a value in bounded chunks and atomically switches a manifest pointer.
 * The legacy base value is retained while state is large, allowing rollback to an
 * older exporter to load the last small valid snapshot.
 */
export async function saveChunkedValue(
	storage: ChunkedValueStorage,
	baseKey: string,
	value: unknown,
): Promise<void> {
	const current = await readCurrentValues(storage, baseKey);
	const previousManifest = current.manifest;
	const generation = previousManifest?.generation === 0 ? 1 : 0;
	const json = JSON.stringify(value);
	if (json === undefined) {
		throw new TypeError("Chunked storage value must be JSON serializable");
	}
	const serialized = new TextEncoder().encode(json);
	if (serialized.byteLength > MAX_SERIALIZED_BYTES) {
		throw new RangeError("Chunked storage value exceeds the safe size limit");
	}

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
		await storage.deleteMany([manifestKey(baseKey)]);
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
		bytes: serialized.byteLength,
	};
	const nextPendingKey = pendingKey(baseKey, generation);
	if (previousManifest === undefined) {
		await cleanupPendingGeneration(storage, baseKey, 0);
		await cleanupPendingGeneration(storage, baseKey, 1);
	} else {
		await cleanupPendingGeneration(storage, baseKey, generation);
	}

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

	await storage.putMany({ [manifestKey(baseKey)]: nextManifest });

	if (previousManifest !== undefined) {
		await cleanupPendingGeneration(
			storage,
			baseKey,
			previousManifest.generation,
		);
	}
	await storage.deleteMany([nextPendingKey]);
}
