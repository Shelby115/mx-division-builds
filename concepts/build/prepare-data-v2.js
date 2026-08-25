// Build script v2: produces a full, engine-ready data bundle (raw CSV rows +
// real icon assets as base64) for the redesigned concepts. Not shipped code.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const CSV = (p) => path.join(ROOT, "public", "csv", p);
const ICONS = (p) => path.join(ROOT, "public", "icons", p);

function parseCSV(str) {
	const rows = [];
	let row = [], field = "", inQuotes = false;
	for (let i = 0; i < str.length; i++) {
		const c = str[i];
		if (inQuotes) {
			if (c === '"') { if (str[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
			else field += c;
		} else {
			if (c === '"') inQuotes = true;
			else if (c === ",") { row.push(field); field = ""; }
			else if (c === "\n" || c === "\r") {
				if (c === "\r" && str[i + 1] === "\n") i++;
				row.push(field); field = "";
				if (row.length > 1 || row[0] !== "") rows.push(row);
				row = [];
			} else field += c;
		}
	}
	if (field !== "" || row.length) { row.push(field); rows.push(row); }
	return rows;
}

function readTable(relPath) {
	const text = fs.readFileSync(CSV(relPath), "utf-8");
	const rows = parseCSV(text);
	const headers = rows[0];
	return rows.slice(1).map((r, i) => {
		const obj = {};
		headers.forEach((h, idx) => (obj[h] = r[idx] !== undefined ? r[idx] : ""));
		obj.index = i + 1;
		return obj;
	});
}

const weapons = readTable("weapons/Weapons.csv");
const weaponTalents = readTable("weapons/WeaponTalents.csv");
const weaponAttributes = readTable("weapons/WeaponAttributes.csv");
const weaponMods = readTable("weapons/WeaponMods.csv");
const gearTalents = readTable("gear/GearTalents.csv");
const gearMods = readTable("gear/GearMods.csv");
const gearAttributes = readTable("gear/Attributes.csv");
const brandSetBonusesRaw = readTable("gear/BrandSetBonuses.csv");
const brandsData = readTable("skills/BrandsData.csv");
const skills = readTable("skills/Skills.csv");
const skillMods = readTable("skills/SkillMods.csv");
const skillStats = readTable("skills/SkillStats.csv");
const statsMapping = readTable("skills/StatsMapping.csv");
const specializationRaw = readTable("general/Specialization.csv");

const GEAR_SLOTS = ["Chest", "Gloves", "Holster", "Kneepads", "Backpack", "Mask"];
const gear = {};
for (const slot of GEAR_SLOTS) gear[slot] = readTable(`gear/${slot}.csv`);

// group specialization perk rows into {name, perks:[{stat,val}]}
const specialization = specializationRaw.reduce((acc, row) => {
	let spec = acc.find((s) => s.name === row.Name);
	if (!spec) { spec = { name: row.Name, perks: [] }; acc.push(spec); }
	if (row.Stat) spec.perks.push({ stat: row.Stat, val: row.Val });
	return acc;
}, []).filter((s) => s.name);

// brand set bonuses: "Brand0"=1pc, "Brand1"=2pc... keep raw tier-encoded Brand key (engine needs it as-is)
const brandSetBonuses = brandSetBonusesRaw.map((b) => ({
	Brand: b.Brand,
	stat: b.stat,
	val: b.val,
	stat1: b.stat1,
	val1: b.val1,
	Talent: b.Talent,
}));

// ---- icon embedding ----
function b64(filePath) {
	try {
		return "data:image/png;base64," + fs.readFileSync(filePath).toString("base64");
	} catch (e) {
		return null;
	}
}

const icons = { ui: {}, brands: {}, skills: {} };
const uiIconFiles = [
	"main-weapon.png", "sidearm.png", "mask.png", "chest.png", "gloves.png",
	"backpack.png", "holster.png", "kneepads.png", "offense1.png", "offense2.png",
	"offense3_1.png", "offense3_2.png", "defense1.png", "defense2.png", "defense3_1.png",
	"defense3_2.png", "tech1.png", "tech2.png", "tech3_1.png", "tech3_2.png",
	"blank_attribute.png", "blank_mod.png", "named.png", "shd.png", "shd_big.png", "shd_med.png",
	"handling1.png",
];
uiIconFiles.forEach((f) => {
	const d = b64(ICONS(f));
	if (d) icons.ui[f] = d;
});
fs.readdirSync(ICONS("brands")).forEach((f) => {
	const d = b64(ICONS("brands/" + f));
	if (d) icons.brands[f] = d;
});
fs.readdirSync(ICONS("skills")).forEach((f) => {
	const d = b64(ICONS("skills/" + f));
	if (d) icons.skills[f] = d;
});

// ---- search index: every place a stat/effect can come from, tagged with meta concepts ----
const META = {
	Survivability: ["armor", "health", "resistance", "hazard protection", "revive", "life"],
	"Armor Regen": ["armor regen"],
	"Skill Power": ["skill haste", "skill damage", "skill duration", "repair skills", "skill tier"],
	"Weapon Damage": ["weapon damage", "damage to", "critical hit", "headshot"],
	Handling: ["stability", "accuracy", "reload speed", "weapon handling", "optimal range"],
	Utility: ["pulse", "cooldown", "ammo capacity"],
};
function tagsFor(text) {
	const lower = text.toLowerCase();
	return Object.entries(META).filter(([, needles]) => needles.some((n) => lower.includes(n))).map(([tag]) => tag);
}
const searchIndex = [];
function addEntry(category, name, group, text) {
	if (!name || !text) return;
	searchIndex.push({ category, name, group: group || "", text, tags: tagsFor(name + " " + text) });
}
weaponTalents.forEach((t) => addEntry("Weapon Talent", t.Name, t.Quality, t.Desc));
gearTalents.forEach((t) => addEntry("Gear Talent", t.Talent, t.Slot, t.Desc));
skills.forEach((s) => addEntry("Skill", `${s["Item Name"]} (${s.Variant})`, s.Specialization || "Any", s.Desc));
skillMods.forEach((m) => addEntry("Skill Mod", `${m["Skill Type"]} Mod`, m["Skill Mod Slot"], `+${m.Max} ${m["Mod Attribute"]}`));
gearAttributes.forEach((a) => addEntry("Attribute", a.Stat, a.Type === "O" ? "Offensive" : a.Type === "D" ? "Defensive" : "Utility", `Up to +${a.Max} ${a.Stat} on gear`));
weaponAttributes.forEach((a) => addEntry("Attribute", a.Stat, "Weapon", `Up to +${a.Max} ${a.Stat} on weapons`));
gearMods.forEach((m) => addEntry("Gear Mod", m.Type, m.Quality, `+${m.Max} ${m.Stat}`));
weaponMods.forEach((m) => addEntry("Weapon Mod", m.Type, m.Quality, `${m.Stat || m.pos || m.neg}`));
const brandGroups = {};
brandSetBonusesRaw.forEach((b) => {
	const match = b.Brand.match(/^(.*?)(\d+)$/);
	if (!match) return;
	const brand = match[1];
	const tier = parseInt(match[2], 10) + 1;
	if (!brandGroups[brand]) brandGroups[brand] = [];
	const parts = [];
	if (b.stat) parts.push(`${b.stat} +${b.val}`);
	if (b.stat1) parts.push(`${b.stat1} +${b.val1}`);
	if (b.Talent) parts.push(b.Talent);
	brandGroups[brand].push({ tier, text: parts.join(", ") });
});
Object.entries(brandGroups).forEach(([brand, tiers]) => tiers.forEach((t) => addEntry("Brand Bonus", brand, `${t.tier}pc`, t.text)));

const bundle = {
	weapons,
	gear,
	weaponTalents,
	weaponAttributes,
	weaponMods,
	gearTalents,
	gearMods,
	gearAttributes,
	brandSetBonuses,
	brandsData,
	skills,
	skillMods,
	skillStats,
	statsMapping,
	specialization,
	icons,
	searchIndex,
	meta: Object.keys(META),
};

const outPath = path.join(__dirname, "data-bundle-v2.json");
fs.writeFileSync(outPath, JSON.stringify(bundle));
console.log("weapons:", weapons.length, "gearTalents:", gearTalents.length, "brandSetBonuses:", brandSetBonuses.length);
console.log("icons: ui", Object.keys(icons.ui).length, "brands", Object.keys(icons.brands).length, "skills", Object.keys(icons.skills).length);
console.log("bundle size (KB):", Math.round(fs.statSync(outPath).size / 1024));
