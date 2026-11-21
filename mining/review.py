"""Replay a dated public calculation; no wallets, model, network, or packages required."""
import json
from decimal import Decimal
from pathlib import Path

snapshot = json.loads(Path(__file__).with_name("snapshot.json").read_text())
dec = Decimal
hashrate = dec(snapshot["hashrate_ksol_s"]) * 1000
difficulty = dec(snapshot["average_difficulty_millions"]) * 1_000_000
blocks_per_day = hashrate * 86_400 / (difficulty * 8192)
electricity_per_day = dec(snapshot["power_w"]) / 1000 * 24 * dec(snapshot["electricity_usd_kwh"])

# ZIP 218's integer rounding and ZIP 214's two funding stream allocations.
gross_zatoshis = 156_250_000 // 3
community_grants = gross_zatoshis * 8 // 100
lockbox = gross_zatoshis * 12 // 100
miner_zec = dec(gross_zatoshis - community_grants - lockbox) / 100_000_000

def electricity_break_even(reward):
    return (electricity_per_day / (blocks_per_day * reward)).quantize(dec("0.01"))

old = electricity_break_even(dec(snapshot["displayed_base_miner_reward_zec"]))
new = electricity_break_even(miner_zec)
matched = old == dec(snapshot["displayed_shutdown_usd_per_zec"]) and new == dec("196.83")
print(json.dumps({
    "result": "PASS" if matched else "FAIL",
    "snapshot_utc": snapshot["snapshot_utc"],
    "base_miner_share_zec": str(miner_zec),
    "electricity_cost_usd_day": str(electricity_per_day),
    "displayed_model_usd_per_zec": str(old),
    "updated_model_usd_per_zec": str(new),
    "scope": "Fixed-input electricity estimate only."
}, indent=2))
raise SystemExit(0 if matched else 1)
