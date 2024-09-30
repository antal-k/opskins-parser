import * as fs from "fs";
import axios from "axios";
import "dotenv/config";

// Settings
const dumpPath = "./dumps";
const MAX_RETRIES = 3;
const PARALLEL_LIMIT = 10;
let prices;

const logFile = "log.txt";
fs.writeFileSync(logFile, "");

function log(message) {
	fs.appendFileSync(logFile, message + "\n");
}

// Load Steam IDs from bots.txt
function loadSteamIds(filename) {
	const data = fs.readFileSync(filename, "utf8");
	return data.split("\n").filter((id) => id.trim() !== ""); // Remove empty lines
}

// Function to retry failed requests
async function retry(fn, retries = MAX_RETRIES) {
	for (let i = 0; i < retries; i++) {
		try {
			return await fn();
		} catch (error) {
			console.log(`Attempt ${i + 1} failed. Retrying...`);
			if (i === retries - 1) {
				throw error;
			}
		}
	}
}

// Fetch prices once at the start
async function fetchPrices() {
	return retry(async () => {
		const response = await axios.get(
			`https://api.pricempire.com/v3/items/prices?sources=buff&currency=USD&appId=730&api_key=${process.env.PRICEMPIRE_API_KEY}`
		);
		return response.data;
	});
}

// Fetch inventory for a given Steam ID with retry logic
async function fetchInventory(steamId) {
	// Check if dump exists for this Steam ID
	const dump = `${dumpPath}/${steamId}.json`;
	if (fs.existsSync(dump)) {
		// log(`Loading inventory from dump for Steam ID: ${steamId}`);
		return JSON.parse(fs.readFileSync(dump, "utf8"));
	}

	return retry(async () => {
		const { data } = await axios.get(
			`https://apis.pricempire.com/v1/inventory?steam_id=${steamId}&app_id=730&api_key=${process.env.PRICEMPIRE_API_KEY}`
		);

		// log(`Dumping inventory for Steam ID: ${steamId}`);

		fs.writeFileSync(dump, JSON.stringify(data, null, 2), {
			encoding: "utf8",
			flag: "w",
		});

		return data;
	});
}

// Count total item values in an inventory
function countItemValues(inventory) {
	let totalValue = 0;
	const { items } = inventory;

	items.forEach((item) => {
		if (!item.item) {
			console.log("Item not found in inventory");
			return;
		}

		if (!prices[item.item.market_hash_name]) {
			console.log(`Price not found for item: ${item.item.market_hash_name}`);
			return;
		}

		const { buff } = prices[item.item.market_hash_name];

		if (!buff) {
			console.log(`Buff not found for item: ${item.item.market_hash_name}`);
			return;
		}

		totalValue += buff.price;
	});

	return totalValue;
}

// Process 50 parallel requests at a time
async function processInBatches(steamIds, batchSize) {
	for (let i = 0; i < steamIds.length; i += batchSize) {
		const batch = steamIds.slice(i, i + batchSize);

		// Run batch in parallel
		const results = await Promise.allSettled(
			batch.map(async (steamId) => {
				try {
					console.log(`Loading inventory for Steam ID: ${steamId}`);
					await fetchInventory(steamId);
				} catch (error) {
					console.error(
						`Failed to process Steam ID ${steamId}: ${error.message}`
					);
				}
			})
		);

		// Handle any rejections
		results.forEach((result, index) => {
			if (result.status === "rejected") {
				console.error(
					`Error processing Steam ID ${batch[index]}: ${result.reason}`
				);
			}
		});
	}
}
async function processData() {
	const filesInDump = fs.readdirSync(dumpPath);

	const items = [];

	filesInDump.forEach((file) => {
		const inventory = JSON.parse(
			fs.readFileSync(`${dumpPath}/${file}`, "utf8")
		);

		const steamId = file.split(".")[0];

		inventory.items.forEach((item) => {
			if (!item.item) {
				console.log("Item not found in inventory");
				return;
			}

			if (!prices[item.item.market_hash_name]) {
				console.log(`Price not found for item: ${item.item.market_hash_name}`);
				return;
			}

			const { buff } = prices[item.item.market_hash_name];

			items.push({
				...item,
				steam_id: steamId,
				// steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S76561198023809011A36273693063D1048292115792704737
				inspect_url: `steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S${steamId}A${item.asset_id}D${item.d}`,
				price: buff?.price || 0,
			});
		});
	});
	return items;
}

// Main function to load Steam IDs, fetch inventories, and calculate total values
async function main() {
	const steamIds = loadSteamIds("bots.txt");

	prices = await fetchPrices();

	await processInBatches(steamIds, PARALLEL_LIMIT);
	const items = await processData();

	/**
	 * Calculate total value of all items
	 */

	log("");
	log("***************************************");
	log("Calculating total value of all items...");
	log("***************************************");
	log("");

	const totalValue = items.reduce((acc, item) => acc + item.price ?? 0, 0);

	log(`Total value: ${formatCurrency(totalValue / 100)}`);

	console.log("");
	console.log("***************************************");
	console.log("Calculating total value by bot...");
	console.log("***************************************");

	const itemsByBot = items.reduce((acc, item) => {
		const steamId = item.steam_id;
		if (!acc[steamId]) {
			acc[steamId] = {
				price: 0,
				count: 0,
			};
		}
		acc[steamId].price += item.price;
		acc[steamId].count += 1;
		return acc;
	}, {});

	// order by price
	const orderedItemsByBot = Object.entries(itemsByBot).sort(
		(a, b) => b[1].price - a[1].price
	);

	for (const [steamId, { price, count }] of orderedItemsByBot) {
		log(
			`${steamId}: ${formatCurrency(price / 100)} (${formatNumber(
				count
			)}) - https://steamcommunity.com/profiles/${steamId}`
		);
	}
	/**
	 * Calculate total value of all items per bot
	 */
	log("");
	log("***************************************");
	log("Calculating total value by category...");
	log("***************************************");
	log("");

	const itemsByCategory = items.reduce((acc, item) => {
		const category = item.item.category;
		if (!acc[category]) {
			acc[category] = {
				price: 0,
				count: 0,
			};
		}
		// acc[category] += item.price;

		acc[category].price += item.price;
		acc[category].count += 1;
		return acc;
	}, {});

	for (const category in itemsByCategory) {
		log(
			`${category}: ${formatCurrency(
				itemsByCategory[category].price / 100
			)} (${formatNumber(itemsByCategory[category].count)})`
		);
	}

	/**
	 * Calculate total value by weapon
	 */

	log("");
	log("***************************************");
	log("Calculating total value by weapon...");
	log("***************************************");
	log("");

	const itemsByWeapon = items
		.filter((item) => item.item.weapon_name)
		.reduce((acc, item) => {
			const weapon = item.item.weapon_name;
			if (!acc[weapon]) {
				acc[weapon] = {
					price: 0,
					count: 0,
				};
			}
			acc[weapon].price += item.price;
			acc[weapon].count += 1;
			return acc;
		}, {});

	for (const weapon in itemsByWeapon) {
		log(
			`${weapon}: ${formatCurrency(
				itemsByWeapon[weapon].price / 100
			)} (${formatNumber(itemsByWeapon[weapon].count)})`
		);
	}

	log("");
	log("***************************************");
	log("Calculating total value by market_hash_name...");
	log("***************************************");
	log("");

	const itemsByMarketHashName = items
		.filter((item) => item.price < 10000)
		.reduce((acc, item) => {
			const name = item.item.market_hash_name;
			if (!acc[name]) {
				acc[name] = {
					price: 0,
					count: 0,
				};
			}
			acc[name].price += item.price;
			acc[name].count += 1;
			return acc;
		}, {});

	// order by count descending
	const orderedItemsByMarketHashName = Object.entries(
		itemsByMarketHashName
	).sort((a, b) => b[1].price - a[1].price);

	for (const [name, { price, count }] of orderedItemsByMarketHashName) {
		if (price < 100 * 100) {
			continue;
		}
		log(`${name}: ${formatCurrency(price / 100)} (${formatNumber(count)})`);
	}

	/**
	 * Searching for katowice 2014 stickers and calculating their value
	 */

	log("");
	log("***************************************");
	log("Searching for Katowice 2014 stickers...");
	log("***************************************");
	log("");

	const katowice2014Stickers = items.filter((item) => {
		return item.item.market_hash_name.includes("Katowice 2014");
	});

	// count and total price by name

	const katowice2014StickersByNames = katowice2014Stickers.reduce(
		(acc, item) => {
			const name = item.item.market_hash_name;
			if (!acc[name]) {
				acc[name] = {
					price: 0,
					count: 0,
				};
			}
			acc[name].price += item.price;
			acc[name].count += 1;
			return acc;
		},
		{}
	);

	for (const name in katowice2014StickersByNames) {
		log(
			`${name}: ${formatCurrency(
				katowice2014StickersByNames[name].price / 100
			)} (${formatNumber(katowice2014StickersByNames[name].count)})`
		);
	}

	// total price of all katowice 2014 stickers

	const totalKatowice2014StickersValue = katowice2014Stickers.reduce(
		(acc, item) => acc + item.price,
		0
	);

	log(
		`Total value of Katowice 2014 stickers: ${formatCurrency(
			totalKatowice2014StickersValue / 100
		)}`
	);

	/**
	 * Search for Katowice 2014 crafts
	 */

	log("");
	log("***************************************");
	log("Searching for Katowice 2014 crafts...");
	log("***************************************");
	log("");

	const katowice2014Crafts = items
		.filter((item) => item.addons)
		.filter((item) => {
			return item.addons?.some((addon) => addon.name.includes("Katowice 2014"));
		});

	katowice2014Crafts.forEach((item) => {
		log(
			`${item.item.market_hash_name} - ${formatCurrency(item.price / 100)} - ${
				item.inspect_url
			}`
		);
	});

	log("Total Katowice 2014 crafts: ", katowice2014Crafts.length);

	log("");
	log("***************************************");
	log("Done!");
	log("***************************************");
	log("");

	log("***************************************");
	log("***************************************");
	log("***************************************");
	log("");

	log("Creating CSV file...");

	// group by market_hash_name

	const itemsByMarketHashName2 = items.reduce((acc, item) => {
		const name = item.item.market_hash_name;
		if (!acc[name]) {
			acc[name] = {
				price: 0,
				count: 0,
			};
		}
		acc[name].price += item.price;
		acc[name].count += 1;
		return acc;
	}, {});

	const itemsByMarketHashNameArray = Object.entries(itemsByMarketHashName2).map(
		([name, { price, count }]) => {
			return {
				name,
				price,
				count,
			};
		}
	);

	const header = "name,qty,date\n";

	const csv = itemsByMarketHashNameArray
		.map((item) => {
			return `${item.name},${item.count},01/01/2019`;
		})
		.join("\n");

	fs.writeFileSync("items.csv", header + csv, "utf8");
}

function formatNumber(value) {
	return new Intl.NumberFormat("en-US").format(value);
}

function formatCurrency(value) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
	}).format(value);
}

main().catch((err) => console.error("Unhandled error:", err));
