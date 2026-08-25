// Build-planner calculation engine — ported from the real app's
// src/utils/statsService.js, src/utils/classes.js, src/utils/utils.js and
// src/utils/SHDutils.js. Pure functions, no Vue/RxJS. Operates on the DATA
// bundle produced by prepare-data-v2.js. Shared by every concept HTML
// (inlined at assemble time).
window.Engine = (function () {
	const CORE_ATTRIBUTES = [
		{ label: "Weapon Damage", Max: 15, Type: "O" },
		{ label: "Skill Tier", Max: 1, Type: "U" },
		{ label: "Armor", Max: 170000, Type: "D" },
	];
	const STAT_TYPE_LABEL = { O: "Offensive", D: "Defensive", U: "Utility" };
	const ICON_BY_TYPE = {
		core: { O: "offense1.png", U: "tech1.png", D: "defense1.png" },
		attribute: { O: "offense2.png", U: "tech2.png", D: "defense2.png", B: "blank_attribute.png" },
		mod: { O: "offense3_2.png", U: "tech3_2.png", D: "defense3_2.png", B: "blank_mod.png" },
	};
	// https://thedivision.fandom.com/wiki/SHD_Level — 4 stats per category, each maxed independently.
	const SHD_LEVELS_DEF = [
		{ name: "Weapon Damage", type: "O", max: 10, group: "Offense" },
		{ name: "Headshot Damage", type: "O", max: 20, group: "Offense" },
		{ name: "Critical Hit Chance", type: "O", max: 10, group: "Offense" },
		{ name: "Critical Hit Damage", type: "O", max: 20, group: "Offense" },
		{ name: "Reload Speed %", type: "O", max: 10, group: "Handling" },
		{ name: "Stability", type: "O", max: 10, group: "Handling" },
		{ name: "Accuracy", type: "O", max: 10, group: "Handling" },
		{ name: "Ammo Capacity", type: "O", max: 20, group: "Handling" },
		{ name: "Total Armor", type: "D", max: 10, group: "Defense" },
		{ name: "Explosive Resistance", type: "D", max: 10, group: "Defense" },
		{ name: "Hazard Protection", type: "D", max: 10, group: "Defense" },
		{ name: "Health", type: "D", max: 10, group: "Defense" },
		{ name: "Skill Haste", type: "U", max: 10, group: "Utility" },
		{ name: "Skill Damage", type: "U", max: 10, group: "Utility" },
		{ name: "Skill Duration", type: "U", max: 20, group: "Utility" },
		{ name: "Repair Skills", type: "U", max: 10, group: "Utility" },
	];

	function keyBy(arr, key) {
		const out = {};
		(arr || []).forEach((x) => (out[key ? x[key] : x] = x));
		return out;
	}
	function defaultSHDLevels() {
		return SHD_LEVELS_DEF.map((d) => ({ name: d.name, type: d.type, max: d.max, group: d.group, value: 0 }));
	}

	function init(DATA) {
		const statsMappingByStat = keyBy(DATA.statsMapping, "Stat");
		const isAny = (v) => v === "A" || v === "" || v === undefined;

		// ---- pick the "best" (highest Max) option from a stat pool ----
		function bestOf(pool) {
			if (!pool || !pool.length) return null;
			return pool.slice().sort((a, b) => Number(b.Max) - Number(a.Max))[0];
		}

		// ---- gear core slot (Weapon Damage / Skill Tier / Armor): identity is fixed by the
		// item unless the CSV leaves it blank ("A", Crafted gear only); the roll VALUE is
		// always overridable by the player, defaulting to max. ----
		function resolveCoreSlot(rawLabel) {
			if (!rawLabel) return null;
			const generic = isAny(rawLabel);
			const base = generic ? CORE_ATTRIBUTES[2] : CORE_ATTRIBUTES.find((c) => c.label === rawLabel);
			if (!base) return null;
			return { label: base.label, Max: base.Max, Type: base.Type, value: base.Max, selectable: generic };
		}

		// ---- minor gear attribute pool/lookup ----
		function attributePool(source, excludeStat) {
			return source
				.filter((a) => a.Quality === "A" && a.Stat !== excludeStat)
				.slice()
				.sort((a, b) => a.Stat.localeCompare(b.Stat));
		}
		function findFixedAttribute(source, name, quality) {
			// Named/Exotic fixed stats roll at their tier's (usually higher) value; fall back
			// to the standard tier if this exact name/tier combo doesn't exist in the table.
			const tier = quality === "Named" ? "N" : quality === "Exotic" ? "E" : "A";
			return (
				source.find((a) => a.Stat === name && a.Quality === tier) ||
				source.find((a) => a.Stat === name && a.Quality === "A") ||
				source.find((a) => a.Stat === name)
			);
		}
		// A CSV cell of "A" means "any minor attribute" (player choice); a real stat name
		// means that slot is fixed to that stat (still player-adjustable in VALUE, not identity).
		// shared by gear (DATA.gearAttributes) and weapons (DATA.weaponAttributes).
		function resolveAttrSlot(source, rawVal, quality, excludeStat) {
			if (!rawVal) return null;
			if (isAny(rawVal)) {
				const pool = attributePool(source, excludeStat);
				const best = bestOf(pool.length ? pool : attributePool(source));
				return best ? { Stat: best.Stat, Max: Number(best.Max), Type: best.Type, value: Number(best.Max), selectable: true } : null;
			}
			const fixed = findFixedAttribute(source, rawVal, quality);
			return fixed ? { Stat: fixed.Stat, Max: Number(fixed.Max), Type: fixed.Type, value: Number(fixed.Max), selectable: false } : null;
		}

		// ---- gear mod slot: always player-selectable when present, from the full mod pool.
		// The CSV's Mod column (O/D/U/A) only says a mod slot exists, not which type it takes -
		// mod slots aren't actually type-locked in game, so every mod is offered everywhere. ----
		function modPool() {
			return DATA.gearMods.filter((m) => m.Quality === "A").slice().sort((a, b) => a.Stat.localeCompare(b.Stat));
		}
		function resolveModSlot(rawCode) {
			if (!rawCode) return null;
			const best = bestOf(modPool());
			return best ? { Stat: best.Stat, Max: Number(best.Max), Type: best.Type, value: Number(best.Max), selectable: true } : null;
		}

		// ---- resolve one gear CSV row into a fully-rolled, player-adjustable instance ----
		function resolveGear(raw) {
			if (!raw) return null;
			const quality = raw.Quality;
			const core = resolveCoreSlot(raw.Core);
			const coreTwo = resolveCoreSlot(raw["Core 2"]);
			const coreThree = resolveCoreSlot(raw["Core 3"]);
			// attribute2 resolved first so attribute1's auto-pick (when both are generic) avoids duplicating it
			const attribute2 = resolveAttrSlot(DATA.gearAttributes, raw["Attribute 2"], quality, null);
			const attribute1 = resolveAttrSlot(DATA.gearAttributes, raw["Attribute 1"], quality, attribute2 ? attribute2.Stat : null);
			const attribute3 = resolveAttrSlot(DATA.gearAttributes, raw["Attribute 3"], quality, null);
			const mod = resolveModSlot(raw.Mod);
			const modTwo = resolveModSlot(raw["Mod 2"]);
			let talent = null, talentAssumed = false;
			if (raw.Talent) {
				if (isAny(raw.Talent)) talentAssumed = true;
				else talent = DATA.gearTalents.find((t) => t.Talent === raw.Talent);
			}
			return {
				raw, name: raw["Item Name"], quality, brand: raw.Brand, icon: raw.Icon, iconRef: raw["Icon Ref"],
				core, coreAssumed: !!(core && core.selectable), coreTwo, coreThree,
				attribute1, attr1Assumed: !!(attribute1 && attribute1.selectable),
				attribute2, attr2Assumed: !!(attribute2 && attribute2.selectable),
				attribute3, attr3Assumed: !!(attribute3 && attribute3.selectable),
				mod, modAssumed: !!(mod && mod.selectable),
				modTwo, modTwoAssumed: !!(modTwo && modTwo.selectable),
				talent, talentAssumed,
			};
		}

		// weapons always carry a weapon-type-specific damage stat as their primary attribute
		// (e.g. "SMG Damage") - fixed identity, but the roll VALUE is still overridable.
		function resolveWeaponCoreSlot(stat, maxRaw) {
			if (!stat) return null;
			const max = Number(maxRaw);
			return { stat, max, value: max };
		}
		// ---- resolve one weapon CSV row into a fully-rolled instance ----
		function resolveWeapon(raw) {
			if (!raw) return null;
			const quality = raw.Quality;
			const core1 = resolveWeaponCoreSlot(raw["Core 1"], raw["Core 1 Max"]);
			const core2 = resolveWeaponCoreSlot(raw["Core 2"], raw["Core 2 Max"]);
			// each weapon type has a default second attribute (e.g. SMG = Critical Hit Chance,
			// LMG = Damage to TOC) - that's Core 2 above, fixed. Attribute 1 is the separately
			// rerollable slot, same "A"=any / named-stat=fixed convention as gear attributes.
			const attribute1 = resolveAttrSlot(DATA.weaponAttributes, raw["Attribute 1"], quality, null);
			let talent = null, talentAssumed = false;
			if (raw.Talent) {
				if (isAny(raw.Talent)) talentAssumed = true;
				else talent = DATA.weaponTalents.find((t) => t.Name === raw.Talent);
			}
			return {
				raw, name: raw.Name, variant: raw.Variant, slot: raw.Slot, quality,
				weaponType: raw["Weapon Type"], icon: raw.Icon, iconRef: raw["Icon Ref"],
				baseDamage: Number(raw["Base Damage"]), rpm: Number(raw.RPM), magSize: Number(raw["Mag Size"]),
				optimalRange: Number(raw["Optimal Range"]), reloadSpeedMs: Number(raw["Reload Speed (ms)"]),
				hsd: Number(raw.HSD),
				core1, core2,
				attribute1, attr1Assumed: !!(attribute1 && attribute1.selectable),
				talent, talentAssumed,
				mods: { optic: raw.Optics, underBarrel: raw["Under Barrel"], magazine: raw.Magazine, muzzle: raw.Muzzle },
			};
		}

		function resolveSkill(raw) {
			if (!raw) return null;
			return { raw, name: raw["Item Name"], variant: raw.Variant, desc: raw.Desc, icon: raw.Icon, status: raw.Status };
		}

		// ---- aggregate a full loadout into totals, faithfully following statsService.js ----
		function computeLoadout(loadout) {
			// loadout: { weapons: {Primary, Secondary, SideArm}, gear: {Chest,...}, specialization: {name} | null, skills: {Skill1, Skill2}, shd: [{name,type,max,value}] }
			const stats = { Offensive: {}, Defensive: {}, Utility: {}, Cores: { Offensive: [], Defensive: [], Utility: [] }, brands: {} };
			const add = (bag, key, val) => { bag[key] = (bag[key] || 0) + Number(val || 0); };
			// gear slots use "Max", weapon core slots use lowercase "max" - accept either.
			const rollOf = (slot) => (slot.value != null ? slot.value : slot.Max != null ? slot.Max : slot.max);

			const gearList = Object.values(loadout.gear || {}).filter(Boolean);
			gearList.forEach((g) => {
				stats.brands[g.brand] = stats.brands[g.brand] || [];
				stats.brands[g.brand].push(g.quality === "Exotic" ? (g.talent ? g.talent.Desc : "Exotic") : null);
				[g.core, g.coreTwo, g.coreThree].forEach((c) => { if (c) stats.Cores[STAT_TYPE_LABEL[c.Type]].push(rollOf(c)); });
				[g.attribute1, g.attribute2, g.attribute3, g.mod, g.modTwo].forEach((stat) => {
					if (stat) add(stats[STAT_TYPE_LABEL[stat.Type]], stat.Stat, rollOf(stat));
				});
			});

			// NinjaBike Messenger Bag: every other equipped brand/gearset counts as if it had
			// one extra piece, for bonus-tier purposes only (doesn't add a real piece).
			const ninjaBikeEquipped = !!(loadout.gear && loadout.gear.Backpack && loadout.gear.Backpack.name === "NinjaBike Messenger Bag");

			// brand set bonuses, tier by equipped count (+1 per brand if NinjaBike is equipped)
			Object.keys(stats.brands).forEach((brand) => {
				const count = stats.brands[brand].length + (ninjaBikeEquipped && brand !== "Exotic" ? 1 : 0);
				const buffs = [];
				for (let tier = 0; tier < count; tier++) {
					const found = DATA.brandSetBonuses.find((b) => b.Brand === brand + tier);
					if (found) {
						if (found.stat === "Talent") {
							buffs.push(found.Talent);
						} else if (found.stat) {
							buffs.push(found.stat + " +" + found.val);
							const t = statsMappingByStat[found.stat];
							if (t) add(stats[STAT_TYPE_LABEL[t.Type]], found.stat, found.val);
							// Skill Tier isn't a plain additive stat — it's derived from how many
							// "cores" contribute to it, same as gear cores, so a brand/gearset tier
							// that grants it must push a core too or the total silently stays at 0.
							if (found.stat === "Skill Tier") stats.Cores.Utility.push(1);
							if (found.stat1 && statsMappingByStat[found.stat1]) {
								buffs.push(found.stat1 + " +" + found.val1);
								const t1 = statsMappingByStat[found.stat1];
								add(stats[STAT_TYPE_LABEL[t1.Type]], found.stat1, found.val1);
								if (found.stat1 === "Skill Tier") stats.Cores.Utility.push(1);
							}
						}
					} else if (brand === "Exotic") {
						buffs.push(...stats.brands[brand].filter(Boolean));
					}
				}
				stats.brands[brand] = buffs;
			});

			// must run before SHD/specialization so a specialization's own "Skill Tier +1"
			// perk (e.g. Technician) adds on top instead of being wiped out by this reset.
			stats.Utility["Skill Tier"] = stats.Cores.Utility.length;

			// SHD Watch levels — flat additive bonuses, same shape as brand/gear stats.
			(loadout.shd || []).forEach((lvl) => { if (lvl.value) add(stats[STAT_TYPE_LABEL[lvl.type]], lvl.name, lvl.value); });

			if (loadout.specialization) {
				["Assault Rifle Damage", "LMG Damage", "Marksman Rifle Damage", "Pistol Damage", "Rifle Damage", "Shotgun Damage", "SMG Damage"]
					.forEach((dmg) => add(stats.Offensive, dmg, 15));
				const spec = DATA.specialization.find((s) => s.name === loadout.specialization.name);
				if (spec) {
					spec.perks.forEach((p) => {
						const t = statsMappingByStat[p.stat];
						if (t) add(stats[STAT_TYPE_LABEL[t.Type]], p.stat, p.val);
					});
				}
			}

			// one shared expertise level (0-30) stands in for every weapon's individual expertise,
			// for simplicity - it adds straight into weapon damage %, same weight as a core roll.
			const expertiseLevel = Number(loadout.expertiseLevel || 0);

			// weapon damage per slot
			function weaponStatsFor(weapon) {
				if (!weapon) return null;
				const AWD = stats.Cores.Offensive.reduce((a, b) => a + b, 0);
				const core1Contribution = stats.Offensive[weapon.core1.stat] || 0;
				const weaponSpecificDamage = expertiseLevel + core1Contribution + rollOf(weapon.core1);
				const genericWeaponDamage = stats.Offensive["Weapon Damage"] || 0;
				const totalPct = AWD + weaponSpecificDamage + genericWeaponDamage;
				const totalDamage = Math.round(weapon.baseDamage * (1 + totalPct / 100));

				function fromGunAndGear(statName) {
					let v = stats.Offensive[statName] || 0;
					if (weapon.core2 && weapon.core2.stat === statName) v += rollOf(weapon.core2);
					if (weapon.attribute1 && weapon.attribute1.Stat === statName) v += rollOf(weapon.attribute1);
					return v;
				}
				const hsd = weapon.hsd + fromGunAndGear("Headshot Damage");
				const chd = 25 + fromGunAndGear("Critical Hit Damage");
				const chc = fromGunAndGear("Critical Hit Chance");
				const dta = fromGunAndGear("Damage to Armor");
				const dtooc = fromGunAndGear("Damage to TOC");

				return {
					weapon, baseDamage: weapon.baseDamage, totalPct, totalDamage,
					hsd, chd, chc,
					dmgToArmored: Math.round(totalDamage * (1 + dta / 100)),
					dmgToOutOfCover: Math.round(totalDamage * (1 + dtooc / 100)),
					rpm: weapon.rpm, magSize: weapon.magSize,
					AWD, weaponSpecificDamage, genericWeaponDamage,
				};
			}

			const weaponStats = {
				Primary: weaponStatsFor(loadout.weapons && loadout.weapons.Primary),
				Secondary: weaponStatsFor(loadout.weapons && loadout.weapons.Secondary),
				SideArm: weaponStatsFor(loadout.weapons && loadout.weapons.SideArm),
			};

			// 660014 is the base armor value for a max-level (40) agent, matching the original app -
			// every piece of gear you wear contributes to this baseline in the real game, it isn't
			// something this per-item dataset tracks separately, so it's a flat constant here too.
			// Gear expertise increases each piece's own base armor (not any attribute or core) by
			// 1% per level - modeled here as the same flat 1%/level applied to the whole constant.
			const BASE_ARMOR_LVL40 = 660014;
			const expertiseBaseArmor = BASE_ARMOR_LVL40 * (1 + expertiseLevel / 100);
			const totals = {
				armor: Math.round((expertiseBaseArmor + stats.Cores.Defensive.reduce((a, b) => a + b, 0)) * (1 + (stats.Defensive["Total Armor"] || 0) / 100)),
				health: stats.Defensive["Health"] || 0,
				skillTier: stats.Utility["Skill Tier"] || 0,
				weaponDamageCores: stats.Cores.Offensive.reduce((a, b) => a + b, 0),
				expertiseLevel, baseArmorLvl40: BASE_ARMOR_LVL40, expertiseBaseArmor,
			};

			return { stats, weaponStats, gearCount: gearList.length, totals };
		}

		function brandProgress(loadout) {
			const counts = {};
			const isGearset = {};
			Object.values(loadout.gear || {}).filter(Boolean).forEach((g) => {
				counts[g.brand] = (counts[g.brand] || 0) + 1;
				if (g.quality === "Gearset") isGearset[g.brand] = true;
			});
			const ninjaBikeEquipped = !!(loadout.gear && loadout.gear.Backpack && loadout.gear.Backpack.name === "NinjaBike Messenger Bag");
			return Object.entries(counts).map(([brand, realCount]) => {
				const count = realCount + (ninjaBikeEquipped && brand !== "Exotic" ? 1 : 0);
				const tiers = [];
				for (let t = 0; t < count; t++) {
					const found = DATA.brandSetBonuses.find((b) => b.Brand === brand + t);
					if (found) tiers.push(found.stat === "Talent" ? found.Talent : found.stat + " +" + found.val + (found.stat1 ? ", " + found.stat1 + " +" + found.val1 : ""));
				}
				return { brand, count, realCount, boosted: count !== realCount, isGearset: !!isGearset[brand], active: tiers };
			});
		}

		function sourceHint(entry) {
			if (entry.category === "Weapon Talent") {
				const names = DATA.weapons.filter((w) => w.Talent === entry.name).map((w) => w.Name);
				return names.length ? "Rolls on: " + names.slice(0, 4).join(", ") + (names.length > 4 ? " +" + (names.length - 4) + " more" : "") : "Recalibration only";
			}
			if (entry.category === "Gear Talent") {
				const names = (DATA.gear[entry.group] || []).filter((g) => g.Talent === entry.name).map((g) => g["Item Name"]);
				return names.length ? "Rolls on " + entry.group.toLowerCase() + ": " + names.slice(0, 4).join(", ") + (names.length > 4 ? " +" + (names.length - 4) + " more" : "") : "Recalibration only";
			}
			if (entry.category === "Brand Bonus") {
				let count = 0;
				Object.values(DATA.gear).forEach((list) => { count += list.filter((g) => g.Brand === entry.name).length; });
				return count + " gear pieces carry " + entry.name;
			}
			return "";
		}

		function iconSrc(kind, filename) {
			if (!filename) return null;
			return (DATA.icons[kind] || {})[filename] || null;
		}
		function uiIcon(filename) { return iconSrc("ui", filename); }
		function slotTypeIcon(kind, type) { return uiIcon((ICON_BY_TYPE[kind] || {})[type] || ICON_BY_TYPE[kind].B); }

		return {
			resolveGear, resolveWeapon, resolveSkill, computeLoadout, brandProgress, iconSrc, uiIcon, slotTypeIcon, sourceHint,
			CORE_ATTRIBUTES, modPool, defaultSHDLevels, SHD_LEVELS_DEF,
			attributePool: (excludeStat) => attributePool(DATA.gearAttributes, excludeStat),
			weaponAttributePool: (excludeStat) => attributePool(DATA.weaponAttributes, excludeStat),
		};
	}

	return { init, defaultSHDLevels, SHD_LEVELS_DEF };
})();
