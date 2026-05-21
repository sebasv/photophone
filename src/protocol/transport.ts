/**
 * Transport: TCP-inspired reliability over a visual channel.
 *
 * The sender splits the payload into numbered packets and cycles through them
 * on its screen. The receiver tracks which sequence numbers it has decoded
 * and, on its own screen, displays an ACK/NACK frame for the sender to read.
 * Both devices need both a screen and a camera.
 */

export interface Packet {
  seq: number;
  total: number;
  payload: Uint8Array;
}

export type Ack =
  | { kind: "ack"; upTo: number }
  | { kind: "nack"; missing: number[] };

export interface SenderState {
  packets: Packet[];
  /** Sequence numbers the receiver has confirmed. */
  acked: Set<number>;
}

export interface ReceiverState {
  total: number | null;
  received: Map<number, Uint8Array>;
}

export function packetize(_payload: Uint8Array, _packetSize: number): Packet[] {
  throw new Error("transport.packetize: not implemented");
}

export function reassemble(_state: ReceiverState): Uint8Array {
  throw new Error("transport.reassemble: not implemented");
}
