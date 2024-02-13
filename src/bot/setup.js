const fs = require("fs");
const chalk = require("chalk");
const ora = require("ora-classic");
const bs58 = require("bs58");
const { Jupiter } = require("@jup-ag/core");
const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = require("@solana/web3.js");

var JSBI = (require('jsbi'));
var invariant = (require('tiny-invariant'));
var _Decimal = (require('decimal.js'));
var _Big = (require('big.js'));
var toFormat = (require('toformat'));
var anchor = require('@project-serum/anchor');

const { logExit } = require("./exit");
const { loadConfigFile, toDecimal } = require("../utils");
const { intro, listenHotkeys } = require("./ui");
const { setTimeout } = require("timers/promises");
const cache = require("./cache");
const wrapUnwrapSOL = cache.wrapUnwrapSOL;

// Account balance code
const balanceCheck = async (checkToken) => {
	let checkBalance = Number(0);
	let t = Number(0);

	const connection = new Connection(process.env.DEFAULT_RPC);
	wallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY));

	if (wrapUnwrapSOL && checkToken.address === 'So11111111111111111111111111111111111111112') {
		// This is where Native balance is needing to be checked and not the Wrapped SOL ATA
		try {
			const balance = await connection.getBalance(wallet.publicKey);
			checkBalance = Number(balance);
		} catch (error) {
			console.error('Error fetching native SOL balance:', error);
		}
	} else {
		// Normal token so look up the ATA balance(s)
		try {
			let totalTokenBalance = BigInt(0);
			const tokenAccounts = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
				mint: new PublicKey(checkToken.address)
			});
		
			tokenAccounts.value.forEach((accountInfo) => {
				const parsedInfo = accountInfo.account.data.parsed.info;
				//console.log(`Pubkey: ${accountInfo.pubkey.toBase58()}`);
				//console.log(`Mint: ${parsedInfo.mint}`);
				//console.log(`Owner: ${parsedInfo.owner}`);
				//console.log(`Decimals: ${parsedInfo.tokenAmount.decimals}`);
				//console.log(`Amount: ${parsedInfo.tokenAmount.amount}`);
				totalTokenBalance += BigInt(parsedInfo.tokenAmount.amount);
				//console.log("====================");
			});
		
			// Convert totalTokenBalance to a regular number
			checkBalance = Number(totalTokenBalance);
			//console.log("Total Token Balance:", checkBalance);
		
		} catch (error) {
			console.error('Error fetching token balance:', error);
		}
	}

	try {
		// Pass back the BN version to match
		let checkBalanceUi = toDecimal(checkBalance,checkToken.decimals);
		console.log(`Wallet balance for ${checkToken.symbol} is ${checkBalanceUi} (${checkBalance})`);
	} catch (error) {
		console.error('Silence is golden.. Or not...:', error);
	}

	if (checkBalance>Number(0)){
			return checkBalance;
	} else {
			return(Number(0));
	}
};

// Handle Balance Errors Messaging
const checkTokenABalance = async (tokenA, initialTradingBalance) => {
	try {
		// Check the balance of TokenA to make sure there is enough to trade
		var realbalanceTokenA = await balanceCheck(tokenA);

		// Make the numebers user friendly
		bal1 = toDecimal(realbalanceTokenA,tokenA.decimals);
		bal2 = toDecimal(initialTradingBalance,tokenA.decimals);

		if (realbalanceTokenA < initialTradingBalance) {
			throw new Error(`\x1b[93mThere is insufficient balance in your wallet of ${tokenA.symbol}\x1b[0m
			\nYou currently only have \x1b[93m${bal1}\x1b[0m ${tokenA.symbol}.
			\nTo run the bot you need \x1b[93m${bal2}\x1b[0m ${tokenA.symbol}.
			\nEither add more ${tokenA.symbol} to your wallet or lower the amount below ${bal1}.\n`);
		}
		// We are gucci
		return realbalanceTokenA;
	} catch (error) {
		// Handle errors gracefully
		console.error(`\n====================\n\n${error.message}\n====================\n`);
		// Return an appropriate error code or rethrow the error if necessary
		process.exit(1); // Exiting with a non-zero code to indicate failure
	}
}

const setup = async () => {
	let spinner, tokens, tokenA, tokenB, wallet;
	try {
		// listen for hotkeys
		listenHotkeys();
		await intro();

		// load config file and store it in cache
		cache.config = loadConfigFile({ showSpinner: false });

		spinner = ora({
			text: "Loading tokens...",
			discardStdin: false,
			color: "magenta",
		}).start();

		// read tokens.json file
		try {
			tokens = JSON.parse(fs.readFileSync("./temp/tokens.json"));
			// find tokens full Object
			tokenA = tokens.find((t) => t.address === cache.config.tokenA.address);

			if (cache.config.tradingStrategy !== "arbitrage")
				tokenB = tokens.find((t) => t.address === cache.config.tokenB.address);
		} catch (error) {
			spinner.text = chalk.black.bgRedBright(
				`\n	Loading tokens failed!\n	Please try to run the Wizard first using ${chalk.bold(
					"`yarn start`"
				)}\n`
			);
			throw error;
		}

		// check wallet private key again
		try {
			spinner.text = "Checking wallet...";
			if (
				!process.env.SOLANA_WALLET_PRIVATE_KEY ||
				(process.env.SOLANA_WALLET_PUBLIC_KEY &&
					process.env.SOLANA_WALLET_PUBLIC_KEY?.length !== 88)
			) {
				throw new Error("Wallet check failed!");
			} else {
				wallet = Keypair.fromSecretKey(
					bs58.decode(process.env.SOLANA_WALLET_PRIVATE_KEY)
				);
			}
		} catch (error) {
			spinner.text = chalk.black.bgRedBright(
				`\n	Wallet check failed! \n	Please make sure that ${chalk.bold(
					"SOLANA_WALLET_PRIVATE_KEY "
				)}\n	inside ${chalk.bold(".env")} file is correct \n`
			);
			logExit(1, error);
			process.exitCode = 1;
			throw error;
		}

		spinner.text = "Setting up connection ...";
		const connection = new Connection(cache.config.rpc[0]);

		spinner.text = "Loading the Jupiter V4 SDK and getting ready to trade...";

		const jupiter = await Jupiter.load({
			connection,
			cluster: cache.config.network,
			user: wallet,
			restrictIntermediateTokens: false,
			shouldLoadSerumOpenOrders: false,
			wrapUnwrapSOL: cache.wrapUnwrapSOL,
			ammsToExclude: {
				'Aldrin': true,
				'Crema': true,
				'Cropper': true,
				'Cykura': true,
				'DeltaFi': true,
				'GooseFX': true,
				'Invariant': true,
				'Lifinity': true,
				'Lifinity V2': true,
				'Marinade': true,
				'Mercurial': true,
				'Meteora': false,
				'Raydium': true,
				'Raydium CLMM': true,
				'Saber': true,
				'Serum': true,
				'Orca': true,
				'Step': true, 
				'Penguin': true,
				'Saros': true,
				'Stepn': true,
				'Orca (Whirlpools)': true,   
				'Sencha': true,
				'Saber (Decimals)': true,
				'Dradex': true,
				'Balansol': true,
				'Openbook': true,
				'Marco Polo': true,
				'Oasis': true,
				'BonkSwap': true,
				'Phoenix': false,
				'Symmetry': true,
				'Unknown': true			
			}
		});
		cache.isSetupDone = true;
		spinner.succeed("Checking to ensure you are ARB ready...\n====================\n");
		return { jupiter, tokenA, tokenB, wallet };
	} catch (error) {
		if (spinner)
			spinner.fail(
				chalk.bold.redBright(`Setting up failed!\n 	${spinner.text}`)
			);
		logExit(1, error);
		process.exitCode = 1;
	}
};

const getInitialotherAmountThreshold = async (
	jupiter,
	inputToken,
	outputToken,
	amountToTrade
) => {
	let spinner;
	try {
        const tokdecimals = cache.sideBuy ? inputToken.decimals : outputToken.decimals;
        const multiplythisbb = JSBI.BigInt(10 ** (tokdecimals));
		spinner = ora({
			text: "Computing routes for token with amountToTrade "+String(amountToTrade)+" with decimals "+tokdecimals+" and multiply is "+String(multiplythisbb),
			discardStdin: false,
			color: "magenta",
		}).start();

		//JSBI AMT to TRADE
		const amountInJSBI = JSBI.BigInt(amountToTrade);

		// compute routes for the first time
		const routes = await jupiter.computeRoutes({
			inputMint: new PublicKey(inputToken.address),
			outputMint: new PublicKey(outputToken.address),
			amount: amountInJSBI,
			slippageBps: 0,
			forceFetch: true,
			onlyDirectRoutes: false,
			filterTopNResult: 1,
		});

		if (routes?.routesInfos?.length > 0) spinner.succeed("Routes computed!");
		else spinner.fail("No routes found. Something is wrong! Check tokens:"+inputToken.address+" "+outputToken.address);

		return routes.routesInfos[0].otherAmountThreshold;
	} catch (error) {
		if (spinner)
			spinner.fail(chalk.bold.redBright("Computing routes failed!\n"));
		logExit(1, error);
		process.exitCode = 1;
	}
};

module.exports = {
	setup,
	getInitialotherAmountThreshold,
	balanceCheck,
	checkTokenABalance,
};
