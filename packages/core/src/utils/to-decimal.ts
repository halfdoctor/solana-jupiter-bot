import BigNumber from "bignumber.js";

export const toDecimal = (
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

	const decimal = v.div(BigNumber(10).pow(decimals));

	return decimal;
};
