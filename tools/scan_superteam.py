"""Rank open Superteam Earn listings by whether they are actually winnable by us.

The research pass ranked listings by reward-per-submission and produced three
top picks that all turned out to be disqualified - not by anything visible in
the listing index, but by requirements buried in the description body. Manic's
bug bounty wants you to deposit USDC and place leveraged trades. ZNS wants you
to launch a token and reach $500 of organic trading volume. Steve Agent Arena
wants five Jupiter swaps of at least 10 USDC each. All three are capital
outlays wearing a bounty's clothes.

So this reads every description and sorts listings into what can actually be
won by writing code and nothing else.

    python tools/scan_superteam.py            # fetch fresh and rank
    python tools/scan_superteam.py --cached   # re-rank what is already on disk
"""

import json
import os
import re
import subprocess
import sys

LISTINGS_URL = "https://superteam.fun/api/listings?take=100"
DETAIL_URL = "https://superteam.fun/api/listings/details/%s"
CACHE_DIR = "superteam_cache"

# Phrases that mean "bring your own money". Every one of these was found in a
# real listing that looked free from the index alone.
CAPITAL_MARKERS = [
    "deposit usdc", "test with real funds", "real money", "fund your",
    "trading volume", "qualifying trade", "execute at least", "swaps of at least",
    "minimum 5 holders", "own capital", "with leverage", "stake at least",
    "entry fee", "submission fee", "registration fee",
]

BUILD_MARKERS = [
    "build", "deploy", "repo", "github", "sdk", "smart contract", "dapp",
    "open source", "integrate", "api", "codebase", "pull request", "bot",
]

CONTENT_MARKERS = [
    "thread", "video", "tweet", "x post", "article", "blog", "meme",
    "creator challenge", "write a", "film ", "vlog", "infographic",
]


def strip_html(raw):
    text = re.sub(r"<[^>]+>", " ", raw or "").replace("&nbsp;", " ").replace("&amp;", "&")
    return re.sub(r"\s+", " ", text).strip()


def fetch(url, path):
    subprocess.run(
        ["curl", "-s", "-m", "40", "-H", "User-Agent: Mozilla/5.0", url, "-o", path],
        check=False,
    )


def load_board(use_cache):
    os.makedirs(CACHE_DIR, exist_ok=True)
    index_path = os.path.join(CACHE_DIR, "_index.json")
    if not use_cache or not os.path.exists(index_path):
        fetch(LISTINGS_URL, index_path)
    with open(index_path, encoding="utf-8") as handle:
        index = json.load(handle)

    listings = []
    for entry in index:
        slug = entry["slug"]
        detail_path = os.path.join(CACHE_DIR, slug + ".json")
        if not os.path.exists(detail_path):
            fetch(DETAIL_URL % slug, detail_path)
        try:
            with open(detail_path, encoding="utf-8") as handle:
                detail = json.load(handle)
        except (OSError, ValueError):
            detail = {}
        listings.append((entry, detail))
    return listings


def classify(entry, detail):
    body = strip_html(detail.get("description")).lower()
    capital = sorted({marker for marker in CAPITAL_MARKERS if marker in body})

    build_score = sum(body.count(marker) for marker in BUILD_MARKERS)
    content_score = sum(body.count(marker) for marker in CONTENT_MARKERS)

    rewards = detail.get("rewards") or {}
    paying_slots = len(rewards) + (detail.get("maxBonusSpots") or 0)
    submissions = (entry.get("_count") or {}).get("Submission", 0)
    amount = entry.get("rewardAmount") or 0

    return {
        "title": entry.get("title", "")[:44],
        "sponsor": (entry.get("sponsor") or {}).get("name", ""),
        "amount": amount,
        "token": entry.get("token"),
        "submissions": submissions,
        "slots": paying_slots,
        "deadline": (entry.get("deadline") or "")[:10],
        "agent_access": entry.get("agentAccess"),
        "capital": capital,
        "kind": "BUILD" if build_score > content_score else "CONTENT",
        # Rough odds of placing: paying slots against the field, capped at 1.
        "hit_rate": min(paying_slots / submissions, 1.0) if submissions else 1.0,
        "per_submission": amount / max(submissions, 1),
    }


def main():
    use_cache = "--cached" in sys.argv
    rows = [classify(entry, detail) for entry, detail in load_board(use_cache)]

    winnable = [r for r in rows if r["kind"] == "BUILD" and not r["capital"]]
    winnable.sort(key=lambda r: -r["per_submission"])

    header = "%-8s %-5s %-5s %-6s %-7s %-11s %-13s %s" % (
        "reward", "tok", "subs", "slots", "odds", "deadline", "agentAccess", "title"
    )
    print("WINNABLE BY WRITING CODE ALONE (no capital, build-type)")
    print(header)
    print("-" * len(header))
    for r in winnable:
        print("%-8s %-5s %-5s %-6s %-7s %-11s %-13s %s | %s" % (
            r["amount"], r["token"], r["submissions"], r["slots"],
            "%.0f%%" % (r["hit_rate"] * 100), r["deadline"],
            r["agent_access"] or "-", r["title"], r["sponsor"],
        ))

    blocked = [r for r in rows if r["capital"]]
    print("\nREQUIRES YOUR OWN MONEY - excluded")
    for r in sorted(blocked, key=lambda r: -r["amount"]):
        print("  %-44s %-6s %s" % (r["title"], r["amount"], ", ".join(r["capital"])))

    content = [r for r in rows if r["kind"] == "CONTENT" and not r["capital"]]
    print("\nCONTENT-TYPE - excluded (AI text hits the plagiarism auto-DQ)")
    for r in sorted(content, key=lambda r: -r["amount"])[:12]:
        print("  %-44s %-6s subs=%s" % (r["title"], r["amount"], r["submissions"]))

    print("\n%d open | %d winnable | %d need capital | %d content" % (
        len(rows), len(winnable), len(blocked), len(content)))


if __name__ == "__main__":
    main()
