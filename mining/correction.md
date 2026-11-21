# Correction for MineOrNot’s Zcash electricity estimate

Your November 20, 2026 snapshot at 16:05 UTC used 1.25 ZEC per block as the miner reward. On the Antminer Z15 Pro preset this produced an electricity break-even price of $65.61 per ZEC. The post-NU7 base amount paid to the miner is 0.41666668 ZEC per block. Substituting that amount gives **$196.83 per ZEC** at the difficulty and electricity price displayed in the same snapshot. [Page](https://mineornot.com/zec/) · [ZIP 218 protocol specification](https://zips.z.cash/zip-0218) · [ZIP 214 funding streams](https://zips.z.cash/zip-0214)

| Frozen input | Value |
| --- | ---: |
| Hashrate | 840 kSol/s |
| Power | 2,780 W |
| Electricity price | $0.10/kWh |
| Difficulty | 108.90 million |
| Daily electricity cost | $6.672 |

The scheduled subsidy is 52,083,333 zatoshis. After the two funding-stream deductions of 4,166,666 and 6,249,999 zatoshis, the miner receives 41,666,668 zatoshis before transaction fees. Another public calculator gives the same amount. [CoinWarz](https://www.coinwarz.com/zcash-mining-calculator)

To reproduce either number, calculate expected blocks per day as 840,000 × 86,400 ÷ (108,900,000 × 8,192). Multiply by the respective base miner reward and divide daily electricity cost by the resulting ZEC per day. Actual earnings depend on difficulty, uptime, fees, pool terms and luck. [Work-factor definition](https://zcashinfo.com/learn/solrate/)

This research sample is ready for a contributor to check against the publisher’s current page. It has not been sent. The observed financial discrepancy is in the displayed estimate. No customer loss was established.
