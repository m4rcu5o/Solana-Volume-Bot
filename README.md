# 🔄 Solana PumpSwap Raydium Meteora Volume Bot

A high-performance Solana trading Bot that interacts with Solana DEX platforms the PumpSwap and Raydium CLMM & CPMM platform for volume boost. This bot is designed to automate the distribution of SOL to multiple wallets and execute endless buy and sell swap transactions on the Pump.fun AMM swap & Raydium platform and withdraw remain fees and close token accounts simultaneously 

## Transaction
- **Pumpswap:** https://solscan.io/tx/ZkEdGvHeu1tR2Agy1RvqcX9XST5YDRFbCPaqTo1kCgPbae7XuKh3qjYmLBbZC7KMHP9GvBadJYzVceBvCZhbhFk

- **Meteora DLMM:** https://explorer.jito.wtf/bundle/558eb9f86665cd3362f0dde7a847452370d0a5c100d6cf1276bc7469ee9728b0

- **Meteora Dynmic AMM:** https://explorer.jito.wtf/bundle/44b1e24a0fb2d2038582deef52a6c5834e9118835f07cc30d76453070e7cfaee

## 💻 Video



https://github.com/user-attachments/assets/66bb9934-1b4a-4ded-9aa6-f4a8beb06986



## 📌 Features

- ✅ Create multiple wallets and Automated SOL Distribution
- ✅ Buy random amount of tokens on certain PumpSwap, Raydium CPMM & CLMM pool and Meteora CLMM & Dynamic AMM 
- ✅ Steadly search old wallets & sell tokens & withdraw SOL & close ATA
- ✅ Auto-logs transactions, volume metrics, and token stats
- ✅ Up to date PumpSwap SDK for sell & buy & getting pool info & calculate buy, sell amount and so on.
- ✅ Configurable Parameters: Allows customization of buy amounts, intervals, distribution settings, and more..

## 🚀 Getting Started

### 1. Clone the Repo

```bash
git clone https://github.com/m4rcu5o/Burn-ATA-Solana.git
cd Burn-ATA-Solana
```
### 2. Clone the Repo
Fill out .env 
```env
MAIN_KEYPAIR_HEX=
TREASURY_WALLET=
MAIN_RPC_URL=
MAIN_WSS_URL=
DEV_RPC_URL=
DEV_WSS_URL=
``` 
### 3. Figure out initial settings

- Example
```typescript
{
    isPumpToken: "y",
    basemint: new web3.PublicKey("Frno4J9Yqdf8uwQKziNyybSQz4bD73mTsmiHQWxhJwGM"),
    minAndMaxBuy: "0.00001 0.00001",
    minAndMaxSell: "0.00001 0.00001",
    delay: "2 3",
    jitoTipAmt: "0.01",
    cycles: 3,
    marketID: "Frno4J9Yqdf8uwQKziNyybSQz4bD73mTsmiHQWxhJwGM"
}
```
### 4. Run with command

Install node modules and run bot with command
```bash
yarn
yarn dev
```

```package.json
"start": "node dist/index.js",
"dev": "ts-node-dev src/index.ts",
"build": "tsc",
```

## 🎫 Contact

[Telegram](https://t.me/stevensprg)

### Please don't forget give ✨Star✨ and 🎞Fork🎞. 😊
