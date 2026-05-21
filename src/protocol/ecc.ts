/**
 * Error correction.
 *
 * V1: Reed-Solomon over GF(256), applied per packet. Survives a bounded number
 * of cell-classification errors per frame without needing retransmission.
 *
 * Future: a fountain code (LT / Raptor) layered across packets, so the
 * receiver can reconstruct the full payload from any sufficient subset of
 * frames — useful before the bidirectional ACK channel is online.
 */

export interface EccConfig {
  /** Data shards per block. */
  dataShards: number;
  /** Parity shards per block. */
  parityShards: number;
}

export const DEFAULT_ECC: EccConfig = { dataShards: 8, parityShards: 4 };

export function encode(_data: Uint8Array, _config: EccConfig): Uint8Array {
  throw new Error("ecc.encode: not implemented");
}

export function decode(_received: Uint8Array, _config: EccConfig): Uint8Array {
  throw new Error("ecc.decode: not implemented");
}
