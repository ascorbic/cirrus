import { encode as cborEncode } from "../cbor-compat";
import type { Sequencer, SeqEvent } from "./sequencer";

/**
 * Encodes and delivers firehose frames to connected WebSocket clients.
 *
 * Runs inside the Durable Object that holds the relay's WebSocket, so
 * nothing here may await slow I/O: a storage op that can't complete in
 * time makes Cloudflare reset the DO, dropping the firehose and
 * desyncing the relay.
 */
export class Firehose {
	constructor(
		private sequencer: Sequencer,
		private getWebSockets: () => WebSocket[],
	) {}

	/**
	 * Encode a firehose frame (header + body CBOR).
	 */
	private encodeFrame(header: object, body: object): Uint8Array {
		const headerBytes = cborEncode(header as any);
		const bodyBytes = cborEncode(body as any);

		const frame = new Uint8Array(headerBytes.length + bodyBytes.length);
		frame.set(headerBytes, 0);
		frame.set(bodyBytes, headerBytes.length);

		return frame;
	}

	/**
	 * Encode any event frame based on its type.
	 */
	private encodeEventFrame(event: SeqEvent): Uint8Array {
		const header = { op: 1, t: `#${event.type}` };
		return this.encodeFrame(header, event.event);
	}

	/**
	 * Encode an error frame.
	 */
	private encodeErrorFrame(error: string, message: string): Uint8Array {
		const header = { op: -1 };
		const body = { error, message };
		return this.encodeFrame(header, body);
	}

	/**
	 * Encode an #info message (op:1, t:'#info'). Used for non-fatal
	 * conditions like OutdatedCursor where the stream continues.
	 */
	private encodeInfoFrame(name: string, message: string): Uint8Array {
		const header = { op: 1, t: "#info" };
		const body = { name, message };
		return this.encodeFrame(header, body);
	}

	/**
	 * Backfill firehose events from a cursor.
	 */
	async backfill(ws: WebSocket, cursor: number): Promise<void> {
		const latestSeq = this.sequencer.getLatestSeq();

		if (cursor > latestSeq) {
			const frame = this.encodeErrorFrame(
				"FutureCursor",
				"Cursor is in the future",
			);
			ws.send(frame);
			ws.close(1008, "FutureCursor");
			return;
		}

		// If the cursor predates the oldest retained event, warn the client
		// with #info OutdatedCursor and resume from the earliest available
		// event. The stream stays open — they just miss the pruned range.
		const earliestSeq = this.sequencer.getEarliestSeq();
		let effectiveCursor = cursor;
		if (earliestSeq !== null && cursor < earliestSeq - 1) {
			const info = this.encodeInfoFrame(
				"OutdatedCursor",
				"Requested cursor exceeded retention window; some events skipped",
			);
			ws.send(info);
			effectiveCursor = earliestSeq - 1;
		}

		const events = await this.sequencer.getEventsSince(effectiveCursor, 1000);

		for (const event of events) {
			const frame = this.encodeEventFrame(event);
			ws.send(frame);
		}

		if (events.length > 0) {
			const lastEvent = events[events.length - 1];
			if (lastEvent) {
				const attachment = ws.deserializeAttachment() as { cursor: number };
				attachment.cursor = lastEvent.seq;
				ws.serializeAttachment(attachment);
			}
		}
	}

	/**
	 * Broadcast a sequenced event to all connected firehose clients.
	 */
	async broadcast(event: SeqEvent): Promise<void> {
		const frame = this.encodeEventFrame(event);

		for (const ws of this.getWebSockets()) {
			try {
				ws.send(frame);

				const attachment = ws.deserializeAttachment() as { cursor: number };
				attachment.cursor = event.seq;
				ws.serializeAttachment(attachment);
			} catch (e) {
				console.error("Error broadcasting to WebSocket:", e);
			}
		}
	}
}
