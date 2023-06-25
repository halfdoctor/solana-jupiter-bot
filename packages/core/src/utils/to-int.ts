import BigNumber from "bignumber.js";

export const toInt = (
	value: string | number | bigint | BigNumber,
	decimals: number
) => {
	const v =
		typeof value === "bigint" || typeof value === "number"
			? BigNumber(value.toString())
			: BigNumber(value);

	const d = BigNumber(decimals);

	if (!d.isInteger()) throw new Error(`Decimals ${decimals} is not an integer`);
	if (!d.isPositive()) throw new Error(`Decimals ${decimals} is not positive`);
	if (!d.isFinite()) throw new Error(`Decimals ${decimals} is not finite`);

	const int = v.times(BigNumber(10).pow(decimals)).integerValue();

	if (!int.isInteger())
		throw new Error(
			`Value ${value} cannot be converted to int with ${decimals} decimals, current result is ${int.toString()}`
		);

	return int;
};
