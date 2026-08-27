import { describe, expect, it } from "vitest";
import { textToStream } from "./prometheus";

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		chunks.push(value);
		total += value.length;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function countChunks(
	stream: ReadableStream<Uint8Array>,
): Promise<number> {
	const reader = stream.getReader();
	let count = 0;
	for (;;) {
		const { done } = await reader.read();
		if (done) {
			break;
		}
		count += 1;
	}
	return count;
}

describe("textToStream", () => {
	it("streams an empty string as an empty byte stream", async () => {
		const bytes = await collect(textToStream(""));
		expect(bytes.length).toBe(0);
	});

	it("round-trips content byte-for-byte", async () => {
		const text = Array.from(
			{ length: 5000 },
			(_, i) => `metric_${i} ${i}`,
		).join("\n");
		const bytes = await collect(textToStream(text, 1024));
		expect(new TextDecoder().decode(bytes)).toBe(text);
	});

	it("emits multiple chunks when the payload exceeds the target size", async () => {
		const text = Array.from({ length: 1000 }, () => "x".repeat(100)).join("\n");
		const chunks = await countChunks(textToStream(text, 1024));
		expect(chunks).toBeGreaterThan(1);
	});

	it("never splits a multi-byte code point across chunks", async () => {
		const text = Array.from({ length: 2000 }, (_, i) => `☃ line ${i}`).join(
			"\n",
		);
		const bytes = await collect(textToStream(text, 64));
		const decoded = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: false,
		}).decode(bytes);
		expect(decoded).toBe(text);
	});
});
