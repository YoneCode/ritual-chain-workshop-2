import { predictAbi } from "./predict-abi";
import { predictAddress } from "./chains";

/** Spread into every wagmi read/write so the address and ABI are declared once. */
export const predictContract = {
  address: predictAddress,
  abi: predictAbi,
} as const;

/** Reads refetch on this interval — fast enough to watch a block-driven state flip. */
export const POLL_MS = 2000;
