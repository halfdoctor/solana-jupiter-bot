import BigNumber from "bignumber.js";
import { toInt } from "./to-int";

export const toBigInt = (
	value: string | number | BigNumber,
	decimals: number
) => {
	const int = toInt(value, decimals);

	return BigInt(int.toString());
};
