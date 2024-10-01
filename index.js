import * as fs from "fs";
import axios from "axios";
import "dotenv/config";

// Constants
const DUMP_PATH = "./dumps";
const MAX_RETRIES = 3;
const PARALLEL_LIMIT = 10;
const LOG_FILE = "log.txt";

// Initialize log file
fs.writeFileSync(LOG_FILE, "");

// Utility functions
const log = (message) => fs.appendFileSync(LOG_FILE, `${message}\n`);
const formatNumber = (value) => new Intl.NumberFormat("en-US").format(value);
const formatCurrency = (value) =>
	new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
		value
	);

const loadSteamIds = (filename) =>
	fs
		.readFileSync(filename, "utf8")
		.split("\n")
		.filter((id) => id.trim() !== "");

// Retry logic for failed requests
const retry = async (fn, retries = MAX_RETRIES) => {
	for (let i = 0; i < retries; i++) {
		try {
			return await fn();
		} catch (error) {
			console.log(`Attempt ${i + 1} failed. Retrying...`);
			if (i === retries - 1) throw error;
		}
	}
};

// API fetching functions
const fetchPrices = () =>
	retry(async () => {
		const { data } = await axios.get(
			`https://api.pricempire.com/v3/items/prices?sources=buff&currency=USD&appId=730&api_key=${process.env.PRICEMPIRE_API_KEY}`
		);
		return data;
	});

const fetchInventory = async (steamId) => {
	const dump = `${DUMP_PATH}/${steamId}.json`;
	if (fs.existsSync(dump)) return JSON.parse(fs.readFileSync(dump, "utf8"));

	return retry(async () => {
		const { data } = await axios.get(
			`https://apis.pricempire.com/v1/inventory?steam_id=${steamId}&app_id=730&api_key=${process.env.PRICEMPIRE_API_KEY}`
		);
		fs.writeFileSync(dump, JSON.stringify(data, null, 2), "utf8");
		return data;
	});
};

// Helper function to calculate item values
const countItemValues = (inventory, prices) => {
	return inventory.items.reduce((totalValue, item) => {
		const priceData = prices[item.item?.market_hash_name]?.buff;
		return totalValue + (priceData?.price || 0);
	}, 0);
};

// Process steam IDs in batches
const processInBatches = async (steamIds, batchSize) => {
	for (let i = 0; i < steamIds.length; i += batchSize) {
		const batch = steamIds.slice(i, i + batchSize);
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
		results.forEach((result, index) => {
			if (result.status === "rejected") {
				console.error(
					`Error processing Steam ID ${batch[index]}: ${result.reason}`
				);
			}
		});
	}
};

// Extract and process data from dump files
const processData = (prices) => {
	const files = fs.readdirSync(DUMP_PATH);
	const items = [];

	files.forEach((file) => {
		const inventory = JSON.parse(
			fs.readFileSync(`${DUMP_PATH}/${file}`, "utf8")
		);
		const steamId = file.split(".")[0];

		inventory.items.forEach((item) => {
			const priceData = prices[item.item?.market_hash_name]?.buff;
			items.push({
				...item,
				steam_id: steamId,
				inspect_url: `steam://rungame/730/76561202255233023/+csgo_econ_action_preview%20S${steamId}A${item.asset_id}D${item.d}`,
				price: priceData?.price || 0,
			});
		});
	});

	return items;
};

// Main function to execute the process
const main = async () => {
	const steamIds = loadSteamIds("bots.txt");
	const prices = await fetchPrices();

	await processInBatches(steamIds, PARALLEL_LIMIT);
	const items = (await processData(prices)).filter((item) => item.item);

	logSection("Calculating total value of all items...");
	const totalValue = items.reduce((acc, item) => acc + (item.price ?? 0), 0);
	log(`Total value: ${formatCurrency(totalValue / 100)}`);

	logSection("Calculating total value by bot...");
	const itemsByBot = groupItems(items, "steam_id");
	displayGroupedData(itemsByBot, steamIds);

	logSection("Calculating total value by category...");
	const itemsByCategory = groupItems(items, (item) => item.item.category);
	displayGroupedData(itemsByCategory);

	logSection("Calculating total value by weapon...");
	const itemsByWeapon = groupItems(items, (item) => item.item.weapon_name);
	displayGroupedData(itemsByWeapon);

	logSection("Calculating total value by market_hash_name...");
	const itemsByMarketHashName = groupItems(
		items,
		(item) => item.item.market_hash_name,
		(item) => item.price < 10000
	);
	displayGroupedData(itemsByMarketHashName, null, true);

	logSection("Searching for Katowice 2014 stickers...");
	const katowice2014Stickers = items.filter((item) =>
		item.item.market_hash_name.includes("Katowice 2014")
	);
	displayGroupedData(
		groupItems(katowice2014Stickers, (item) => item.item.market_hash_name)
	);

	logSection("Searching for Katowice 2014 crafts...");
	const katowice2014Crafts = items.filter((item) =>
		item.addons?.some((addon) => addon.name.includes("Katowice 2014"))
	);
	katowice2014Crafts.forEach((item) =>
		log(
			`${item.item.market_hash_name} - ${formatCurrency(item.price / 100)} - ${
				item.inspect_url
			}`
		)
	);

	log("Creating CSV file...");
	createCsv(items, "items.csv");
};

// Helper functions for grouping and displaying data
const groupItems = (items, keyFn, filterFn = null) => {
	return items.filter(filterFn || (() => true)).reduce((acc, item) => {
		const key = typeof keyFn === "function" ? keyFn(item) : item[keyFn];
		if (!acc[key]) acc[key] = { price: 0, count: 0 };
		acc[key].price += item.price;
		acc[key].count += 1;
		return acc;
	}, {});
};

const displayGroupedData = (
	groupedData,
	ids = null,
	skipSmallPrices = false
) => {
	const sortedData = Object.entries(groupedData).sort(
		(a, b) => b[1].price - a[1].price
	);
	for (const [key, { price, count }] of sortedData) {
		if (skipSmallPrices && price < 100 * 100) continue;
		log(`${key}: ${formatCurrency(price / 100)} (${formatNumber(count)})`);
	}
};

// Logging helpers
const logSection = (message) => {
	log("");
	log("***************************************");
	log(message);
	log("***************************************");
	log("");
};

// Create CSV from items
const createCsv = (items, filename) => {
	const groupedItems = groupItems(items, (item) => item.item.market_hash_name);

	const header = "name,qty,value\n";

	const rows = Object.entries(groupedItems)
		.map(([name, { count, price }]) => `${name},${count},${price}`)
		.join("\n");

	fs.writeFileSync(filename, header + rows, "utf8");

	/*
	const header = "name,qty,date\n";
	const rows = items
		.map((item) => `${item.item.market_hash_name},${item.count},01/01/2019`)
		.join("\n");
	fs.writeFileSync(filename, header + rows, "utf8");
	*/
};

// Execute main
main().catch((err) => console.error("Unhandled error:", err));
