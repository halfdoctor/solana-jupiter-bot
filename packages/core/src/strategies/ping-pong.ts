import { TokenInfo } from "src/types/token";
import {
	createArray,
	parseError,
	thingToMulti,
	toBigInt,
	toDecimal,
	toInt,
} from "../utils";
import { Strategy } from "src/types/strategy";
import BigNumber from "bignumber.js";
import { Order } from "src/types/global-state";
import { Bot } from "src";

// TODO: restore auto-reset!
// TODO: restore stop-loss!

type shouldExecute = {
	value: boolean;
	reason: "default" | "price-match" | "forced-by-user";
};

export type PingPongStrategyConfig = {
	inToken?: {
		initialOutAmount: bigint;

		token: TokenInfo;
	};
	outToken?: {
		initialOutAmount: bigint;

		token: TokenInfo;
	};
	amount: number;
	slippage: number;
	/**
	 * Auto slippage will try to prevent losses by setting the slippage threshold
	 * to the previous out amount of the current out token. This will not guarantee that
	 * tx will not lead to losses though.
	 */
	enableAutoSlippage: boolean;
	/**
	 * If enabled, the bot will compound the profit of the previous trade
	 */
	enableCompounding: boolean;
	executeAboveExpectedProfitPercent: number;
	priorityFeeMicroLamports?: number;
	lock?: boolean;
	expectedProfitBasedStopLoss?: {
		enabled: boolean;
		percent: number;
	};
	onStopLossAction?: "sell&reset" | "shutdown" | "sell&shutdown";
	shouldReset?: boolean;
	autoReset?: {
		enabled: boolean;
		timeWindowMs: number;
	};
	initialOutAmount?: bigint;
};

export const PingPongStrategy: Strategy<PingPongStrategyConfig> = {
	id: "ping-pong",
	name: "Ping Pong",
	description: "Ping Pong Strategy WOW",
	version: "0.0.2",
	config: {
		amount: 0,
		slippage: 50,
		executeAboveExpectedProfitPercent: 1,
		lock: false,
		enableAutoSlippage: false,
		enableCompounding: false,
	},
	uiHook: {},
	// dependencies: {
	// 	minTokens: 2,
	// 	maxTokens: 2,
	//  supportedAggregators: ["jupiter", "prism"]
	// },
	setConfig(initialConfig) {
		this.config = initialConfig;
	},
	async init(bot) {
		if (!this.config.tokensInfo) {
			throw new Error("PingPongStrategy:init: tokensInfo not provided");
		}
		if (!this.config.tokensInfo[0] || !this.config.tokensInfo[1]) {
			throw new Error("PingPongStrategy:init: not enough tokens provided");
		}

		const initialTradeAmount = thingToMulti.fromUiValue(
			this.config.amount,
			this.config.tokensInfo[0].decimals
		);

		if (!initialTradeAmount) {
			const msg = "PingPongStrategy:init:error invalid amount";
			bot.logger.error(
				{
					amount: this.config.amount,
					decimals: this.config.tokensInfo[0].decimals,
				},
				msg
			);
			throw new Error(msg);
		}

		const results = await bot.aggregators[0].computeRoutes({
			inToken: this.config.tokensInfo[0].address,
			outToken: this.config.tokensInfo[1].address,
			amount: BigInt(
				this.config.amount * 10 ** this.config.tokensInfo[0].decimals
			),
			slippage: 50,
			runtimeId: "init",
		});

		if (!results.success) {
			throw new Error(
				"PingPongStrategy:init:error: " + JSON.stringify(results.error)
			);
		}

		this.config.inToken = {
			initialOutAmount: BigInt(
				this.config.amount * 10 ** this.config.tokensInfo[0].decimals
			),

			token: this.config.tokensInfo[0],
		};

		const amountOut = results.routes[0]?.amountOut;
		if (!amountOut) {
			throw new Error("PingPongStrategy:init: amountOut not provided");
		}
		const outAmountAsDecimal = thingToMulti.fromBlockchainValue(
			amountOut,
			this.config.tokensInfo[1].decimals
		)?.uiValue.decimal;

		if (!outAmountAsDecimal) {
			const msg = "PingPongStrategy:init:error outAmountAsDecimal is undefined";
			bot.logger.error(msg);
			throw new Error(msg);
		}

		this.config.outToken = {
			initialOutAmount: amountOut,
			token: this.config.tokensInfo[1],
		};
		if (!this.config.inToken || !this.config.outToken) {
			throw new Error("PingPongStrategy:init: not enough tokens provided");
		}

		// show profit threshold
		const profitThreshold = this.config.executeAboveExpectedProfitPercent;
		bot.store.setState((state) => {
			const ind = {
				values: createArray(
					state.chart.expectedProfitPercent.values.length,
					profitThreshold
				),
				label: "threshold",
				color: "darkgray",
			};
			state.chart.expectedProfitPercent.indicators = [ind];
		});

		// report priority fee
		if (this.config.priorityFeeMicroLamports) {
			bot.reportPriorityFeeMicroLamports(this.config.priorityFeeMicroLamports);
		}

		// report auto slippage
		bot.reportAutoSlippage(0, this.config.enableAutoSlippage);

		// report desired profit percent per trade
		bot.desiredProfitPercentPerTx(
			this.config.executeAboveExpectedProfitPercent
		);

		// bot set listener for shouldReset event
		bot.onStatusChange("strategy:shouldReset", () => {
			this.config.shouldReset = true;
		});
	},
	async run(runtimeId, bot, done) {
		try {
			if (!this.config.tokensInfo?.[0] || !this.config.tokensInfo[1]) {
				throw new Error("PingPongStrategy:init: not enough tokens provided");
			}

			const market = [
				this.config.tokensInfo[0].address,
				this.config.tokensInfo[1].address,
			];

			let strategyOpenOrders: Order[] = [];
			let strategyFilledOrders: Order[] = [];

			for (const [_, order] of bot.store.getState().orders) {
				if (order.strategyId === this.id) {
					order.isExecuted
						? strategyFilledOrders.push(order)
						: strategyOpenOrders.push(order);
				}
			}

			//  If there is no open order, place a new order
			if (strategyOpenOrders.length === 0) {
				const order = createOrder({
					config: this.config,
					market,
					strategyId: this.id,
					runtimeId,
					strategyFilledOrders,
				});

				// add new order to store
				bot.store.setState((s) => {
					s.orders.set(runtimeId, order);
				});

				// update open orders
				strategyOpenOrders.push(order);
			}

			// check again if there are any open orders
			if (!strategyOpenOrders[0]) {
				throw new Error("PingPongStrategy:run: no open orders");
			}

			const order = strategyOpenOrders[0];

			const { shouldExecute, outAmount } = await checkOrder({
				runtimeId,
				bot,
				order,
				config: this.config,
			});

			const inToken = this.config.tokensInfo?.find(
				(token) => token.address === order.inTokenAddress
			);
			const outToken = this.config.tokensInfo?.find(
				(token) => token.address === order.outTokenAddress
			);

			if (!inToken || !outToken) {
				throw new Error(
					"PingPongStrategy:run: tokenIn or tokenOut is undefined"
				);
			}

			// TODO: refactor this
			const initialOutAmount =
				this.config.inToken?.token.address === outToken.address
					? this.config.inToken?.initialOutAmount
					: this.config.outToken?.token.address === outToken.address
					? this.config.outToken?.initialOutAmount
					: undefined;

			if (!initialOutAmount) {
				throw new Error("PingPongStrategy:run: initialOutAmount is undefined");
			}

			const previousFilledOrder = strategyFilledOrders.find(
				(o) => o.direction === order.direction
			);

			const prevOutAmount =
				previousFilledOrder?.outAmountInt ?? initialOutAmount;

			const recentOutAmountInt = BigNumber(prevOutAmount.toString());

			const recentOutAmount = toDecimal(
				recentOutAmountInt,
				order.outTokenDecimals
			);

			const expectedProfit = outAmount.minus(recentOutAmount);

			const expectedProfitPercent = expectedProfit
				.div(recentOutAmount)
				.times(100);

			bot.reportExpectedProfitPercent(expectedProfitPercent.toNumber());

			if (shouldExecute.value) {
				if (shouldExecute.reason === "forced-by-user") {
					bot.store.setState((state) => {
						state.status.value = "execute:shouldExecute";
					});
					bot.logger.info(
						{ runtimeId },
						"PingPongStrategy:run:shouldExecute user forced execution"
					);
				}

				/** REPORT PRIORITY FEE */
				if (this.config.priorityFeeMicroLamports) {
					bot.reportPriorityFeeMicroLamports(
						this.config.priorityFeeMicroLamports
					);
				}

				/** AUTO SLIPPAGE */
				let customSlippageThreshold: bigint | undefined;

				if (this.config.enableAutoSlippage) {
					customSlippageThreshold = prevOutAmount;

					bot.reportAutoSlippage(
						recentOutAmount.toNumber(),
						this.config.enableAutoSlippage
					);

					bot.logger.debug(
						{ runtimeId },
						`PingPongStrategy:run: customSlippageThreshold set to ${customSlippageThreshold}`
					);
				}

				/** EXECUTE ORDER */
				const result = await bot.aggregators[0].execute({
					runtimeId,
					amount: order.sizeInt,
					inToken: order.inTokenAddress,
					outToken: order.outTokenAddress,
					slippage: order.slippageBps ?? 100,
					priorityFeeMicroLamports: this.config.priorityFeeMicroLamports,
					calculateProfit({ outAmountInt, outToken }) {
						const outAmount = toDecimal(outAmountInt, outToken.decimals);

						if (order.direction === "buy") {
							const unrealizedProfitPercent = outAmount
								.minus(recentOutAmount)
								.div(recentOutAmount)
								.times(100);

							bot.reportUnrealizedProfitPercent(
								unrealizedProfitPercent.toNumber()
							);

							const unrealizedProfit = outAmount.minus(recentOutAmount);

							return {
								profit: "0",
								profitInt: BigInt(0),
								profitPercent: "0",
								unrealizedProfit: unrealizedProfit.toString(),
								unrealizedProfitInt: BigInt(unrealizedProfit.toString()),
								unrealizedProfitPercent: unrealizedProfitPercent.toString(),
							};
						}

						const profit = outAmount.minus(recentOutAmount);

						const profitPercent = profit.div(recentOutAmount).times(100);

						bot.reportUnrealizedProfitPercent(0);

						return {
							profit: profit.toString(),
							profitInt: BigInt(profit.toString()),
							profitPercent: profitPercent.toString(),
							unrealizedProfit: "0",
							unrealizedProfitInt: BigInt(0),
							unrealizedProfitPercent: "0",
						};
					},
				});

				if (result.status === "success") {
					// set order as executed
					bot.store.setState((state) => {
						state.orders.set(order.id, {
							...order,
							isExecuted: true,
							executedAt: Date.now(),
							outAmountInt: result.outAmount,
						});
					});
				}
			}
		} catch (error) {
			const parsedError = parseError(error);

			console.log("error", parsedError);
			bot.logger.error(
				{
					stack: parsedError?.stack,
					runtimeId,
				},
				`PingPongStrategy:run:error ${parsedError?.message}`
			);
		} finally {
			done(this);
		}
	},
};

const createOrder = ({
	config,
	market,
	strategyFilledOrders,
	runtimeId,
	strategyId,
}: {
	config: typeof PingPongStrategy.config;
	market: string[];
	strategyFilledOrders: Order[];
	runtimeId: string;
	strategyId: string;
}) => {
	if (!config.tokensInfo?.[0] || !config.tokensInfo[1]) {
		throw new Error("PingPongStrategy:init: not enough tokens provided");
	}

	const recentFilledOrder = strategyFilledOrders.at(-1);

	const direction = recentFilledOrder?.direction === "buy" ? "sell" : "buy";
	console.log("direction ", direction);

	const inTokenAddress = market[direction === "buy" ? 0 : 1];
	const outTokenAddress = market[direction === "buy" ? 1 : 0];

	console.log("inTokenAddress", inTokenAddress);
	console.log("outTokenAddress", outTokenAddress);

	const inToken = config.tokensInfo?.find(
		(token) => token.address === inTokenAddress
	);
	const outToken = config.tokensInfo?.find(
		(token) => token.address === outTokenAddress
	);

	if (!inToken || !outToken) {
		throw new Error("PingPongStrategy:run: tokenIn or tokenOut is undefined");
	}

	const slippage = config.slippage;

	const previousBuyOrder = strategyFilledOrders.find(
		(order) => order.direction === "buy"
	);
	console.log("previousBuyOrder", previousBuyOrder);
	const previousSellOrder = strategyFilledOrders.find(
		(order) => order.direction === "sell"
	);

	// TODO: add compounding
	const sizeInt: bigint | undefined =
		direction === "buy"
			? toBigInt(config.amount, config.tokensInfo[0].decimals)
			: previousBuyOrder?.outAmountInt;

	console.log("sizeInt", sizeInt);

	if (!sizeInt) {
		throw new Error("PingPongStrategy:run: sizeInt is undefined");
	}

	let prevOutAmount =
		direction === "buy"
			? previousBuyOrder?.outAmountInt
			: previousSellOrder?.outAmountInt;
	console.log("prevOutAmount ", prevOutAmount);

	if (!prevOutAmount && direction === "buy") {
		// TODO: refactor this
		const initialOutAmount = config.outToken?.initialOutAmount;

		if (!initialOutAmount) {
			throw new Error("PingPongStrategy:run: initialOutAmount is undefined");
		}

		console.log("initialOutAmount", initialOutAmount);

		prevOutAmount = initialOutAmount;
	} else if (!prevOutAmount && direction === "sell") {
		const initialOutAmount = config.inToken?.initialOutAmount;

		if (!initialOutAmount) {
			throw new Error("PingPongStrategy:run: initialOutAmount is undefined");
		}

		console.log("initialOutAmount", initialOutAmount);

		prevOutAmount = initialOutAmount;
	}

	if (!prevOutAmount) {
		throw new Error("PingPongStrategy:run: prevOutAmount is undefined");
	}

	const recentOutAmount = BigNumber(prevOutAmount.toString());

	console.log("prevOutAmount", prevOutAmount.toString());
	console.log("recentOutAmount", recentOutAmount.toString());

	// calculate what is desired price based on desired profit percent
	const desiredProfitPercent = config.executeAboveExpectedProfitPercent;

	console.log("desiredProfitPercent", desiredProfitPercent);

	// recent out amount + desired profit percent
	const desiredOutAmount = recentOutAmount
		.div(BigNumber(10 ** outToken.decimals))
		.times(BigNumber(1 + desiredProfitPercent));

	console.log("desiredOutAmount", desiredOutAmount.toString());

	const desiredPrice = toInt(desiredOutAmount, outToken.decimals)
		.div(BigNumber(sizeInt.toString()))
		.div(BigNumber(10 ** (outToken.decimals - inToken.decimals)));

	console.log("desiredPrice", desiredPrice.toString());

	const invertedDesiredPrice = BigNumber(sizeInt.toString())
		.div(desiredOutAmount.times(BigNumber(10 ** outToken.decimals)))
		.div(BigNumber(10 ** (inToken.decimals - outToken.decimals)));

	console.log("invertedDesiredPrice", invertedDesiredPrice.toString());

	const order: Order = {
		id: runtimeId,
		strategyId,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		direction,
		type: "limit-like",
		sizeInt: sizeInt,
		size: BigNumber(sizeInt.toString())
			.div(BigNumber(10 ** inToken.decimals))
			.toString(),
		inTokenAddress: inToken.address,
		outTokenAddress: outToken.address,
		inTokenSymbol: inToken.symbol || "n/a",
		outTokenSymbol: outToken.symbol || "n/a",
		inTokenDecimals: inToken.decimals,
		outTokenDecimals: outToken.decimals,
		price:
			direction === "buy"
				? invertedDesiredPrice.toString()
				: desiredPrice.toString(),
		desiredOutAmount: desiredOutAmount.toString(),
		slippageBps: slippage,
	};

	return order;
};

const checkOrder = async ({
	runtimeId,
	bot,
	config,
	order,
}: {
	runtimeId: string;
	bot: Bot;
	order: Order;
	config: typeof PingPongStrategy.config;
}) => {
	const computedRoutes = await bot.aggregators[0].computeRoutes({
		inToken: order.inTokenAddress,
		outToken: order.outTokenAddress,
		amount: order.sizeInt,
		runtimeId,
		slippage: order.slippageBps || 50,
	});

	// get best route
	if (!computedRoutes.success || !Array.isArray(computedRoutes.routes)) {
		throw new Error("PingPongStrategy:run: no routes found");
	}

	const bestRoute = computedRoutes.routes[0];

	if (!bestRoute) {
		throw new Error("PingPongStrategy:run: no routes found");
	}

	const outAmountInt = BigNumber(bestRoute.amountOut.toString());
	const outAmount = toDecimal(outAmountInt, order.outTokenDecimals);

	// get best route price

	const price =
		order.direction === "buy"
			? BigNumber(bestRoute.amountIn.toString())
					.div(BigNumber(bestRoute.amountOut.toString()))
					.div(
						BigNumber(10 ** (order.inTokenDecimals - order.outTokenDecimals))
					)
			: BigNumber(bestRoute.amountOut.toString())
					.div(BigNumber(bestRoute.amountIn.toString()))
					.div(
						BigNumber(10 ** (order.outTokenDecimals - order.inTokenDecimals))
					);

	if (!order.price) {
		throw new Error("PingPongStrategy:run: error missing order price");
	}

	if (!order.desiredOutAmount) {
		throw new Error(
			"PingPongStrategy:run: error missing order desiredOutAmount"
		);
	}

	let shouldExecute: shouldExecute = {
		value: bot.store.getState().strategies.current.shouldExecute,
		reason: bot.store.getState().strategies.current.shouldExecute
			? "forced-by-user"
			: "default",
	};

	console.log("ping-pong:shouldExecute initial value: ", shouldExecute);

	if (order.direction === "buy") {
		console.log("[BUY] check price vs order price", {
			price: price.toString(),
			orderPrice: order.price,
		});
		if (price.isLessThanOrEqualTo(BigNumber(order.price))) {
			console.log("price is lower than the order, execute the order");
			shouldExecute.value = true;
			shouldExecute.reason = "price-match";
		}
	}

	if (order.direction === "sell") {
		console.log("[SELL] check price vs order price", {
			price: price.toString(),
			orderPrice: order.price,
		});

		if (price.isGreaterThanOrEqualTo(BigNumber(order.price))) {
			console.log("price is higher than the order, execute the order");
			shouldExecute.value = true;
			shouldExecute.reason = "price-match";
		}
	}

	return {
		shouldExecute,
		outAmount,
		price,
	};
};
