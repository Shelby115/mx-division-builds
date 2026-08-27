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
	// each gear slot's own base armor at 0% expertise (real per-slot values, not an even
	// split - Chest and Backpack carry noticeably more than Mask/Gloves/Holster/Kneepads).
	const GEAR_SLOT_BASE_ARMOR = { Mask: 80000, Backpack: 131000, Chest: 158000, Gloves: 80000, Holster: 112000, Kneepads: 99000 };
	const BASE_ARMOR_LVL40 = Object.values(GEAR_SLOT_BASE_ARMOR).reduce((a, b) => a + b, 0);
	// a single equipped piece's own base armor at a given expertise level (1% per level, on
	// that piece's own base only - not the player's innate base, not any core/attribute)
	function gearPieceArmor(slotKey, expertiseLevel) {
		const base = GEAR_SLOT_BASE_ARMOR[slotKey] || 0;
		return Math.round(base * (1 + Number(expertiseLevel || 0) / 100));
	}
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
		// always overridable by the player, defaulting to max. The listed core is only the
		// default roll, not a hard lock - recalibration can reroll it to any of the 3, so the
		// primary core slot is selectable on every non-Exotic piece (Exotic core setups are
		// fixed/signature, e.g. Memento's 3 cores, and can't be recalibrated). ----
		function resolveCoreSlot(rawLabel, alwaysSelectable) {
			if (!rawLabel) return null;
			const generic = isAny(rawLabel);
			const base = generic ? CORE_ATTRIBUTES[2] : CORE_ATTRIBUTES.find((c) => c.label === rawLabel);
			if (!base) return null;
			return { label: base.label, Max: base.Max, Type: base.Type, value: base.Max, selectable: generic || !!alwaysSelectable };
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
			const core = resolveCoreSlot(raw.Core, quality !== "Exotic");
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

		// ---- weapon attachments (Optic / Under Barrel / Magazine / Muzzle). A weapon's raw CSV
		// cell lists "/"-separated compatible mod Type tokens ("Neutral / Short / Long"); many
		// Named/Exotic weapons instead list a single Type matching their own name, meaning that
		// slot has exactly one dedicated mod (still shown, just not a real choice). Unlike gear
		// attributes the bonus VALUE is fixed per attachment - picking one picks its value too. ----
		function weaponModPool(slotLabel, typeFilter) {
			if (!typeFilter) return [];
			const types = typeFilter.split("/").map((t) => t.trim()).filter(Boolean);
			return DATA.weaponMods.filter((m) => m.Slot === slotLabel && types.includes(m.Type));
		}
		function resolveWeaponModSlot(slotLabel, typeFilter) {
			const pool = weaponModPool(slotLabel, typeFilter);
			if (!pool.length) return null;
			const best = pool.slice().sort((a, b) => (Number(b.valPos) || 0) - (Number(a.valPos) || 0))[0];
			return {
				slot: slotLabel, name: best.Name, type: best.Type,
				pos: best.pos || null, valPos: Number(best.valPos) || 0,
				neg: best.neg || null, valNeg: Number(best.valNeg) || 0,
				selectable: pool.length > 1,
			};
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
			const mods = {
				optic: resolveWeaponModSlot("Optic", raw.Optics),
				underBarrel: resolveWeaponModSlot("Under Barrel", raw["Under Barrel"]),
				magazine: resolveWeaponModSlot("Magazine", raw.Magazine),
				muzzle: resolveWeaponModSlot("Muzzle", raw.Muzzle),
			};
			return {
				raw, name: raw.Name, variant: raw.Variant, slot: raw.Slot, quality,
				weaponType: raw["Weapon Type"], icon: raw.Icon, iconRef: raw["Icon Ref"],
				baseDamage: Number(raw["Base Damage"]), rpm: Number(raw.RPM), magSize: Number(raw["Mag Size"]),
				optimalRange: Number(raw["Optimal Range"]), reloadSpeedMs: Number(raw["Reload Speed (ms)"]),
				hsd: Number(raw.HSD),
				core1, core2,
				attribute1, attr1Assumed: !!(attribute1 && attribute1.selectable),
				talent, talentAssumed,
				mods,
			};
		}

		function resolveSkill(raw) {
			if (!raw) return null;
			return { raw, name: raw["Item Name"], variant: raw.Variant, desc: raw.Desc, icon: raw.Icon, status: raw.Status };
		}

		// ---- aggregate a full loadout into totals, faithfully following statsService.js ----
		function computeLoadout(loadout) {
			// loadout: { weapons: {Primary, Secondary, SideArm}, gear: {Chest,...}, specialization: {name} | null, skills: {Skill1, Skill2}, shd: [{name,type,max,value}] }
			const stats = { Offensive: {}, Defensive: {}, Utility: {}, Cores: { Offensive: [], Defensive: [], Utility: [] }, brands: {}, Sources: {} };
			// every additive stat contribution optionally records where it came from (a plain
			// label), so a tooltip can later explain a total instead of just showing the number -
			// currently only surfaced for Critical Hit Chance, but works for any stat.
			const add = (bag, key, val, source) => {
				bag[key] = (bag[key] || 0) + Number(val || 0);
				if (source && val) {
					stats.Sources[key] = stats.Sources[key] || [];
					stats.Sources[key].push({ source, amount: Number(val) });
				}
			};
			// gear slots use "Max", weapon core slots use lowercase "max" - accept either.
			const rollOf = (slot) => (slot.value != null ? slot.value : slot.Max != null ? slot.Max : slot.max);

			const gearList = Object.values(loadout.gear || {}).filter(Boolean);
			Object.entries(loadout.gear || {}).forEach(([slotKey, g]) => {
				if (!g) return;
				stats.brands[g.brand] = stats.brands[g.brand] || [];
				stats.brands[g.brand].push(g.quality === "Exotic" ? (g.talent ? g.talent.Desc : "Exotic") : null);
				[g.core, g.coreTwo, g.coreThree].forEach((c) => { if (c) stats.Cores[STAT_TYPE_LABEL[c.Type]].push(rollOf(c)); });
				[["attribute1", g.attribute1], ["attribute2", g.attribute2], ["attribute3", g.attribute3], ["mod", g.mod], ["modTwo", g.modTwo]].forEach(([field, stat]) => {
					if (stat) add(stats[STAT_TYPE_LABEL[stat.Type]], stat.Stat, rollOf(stat), slotKey + " (" + g.name + ")" + (/mod/i.test(field) ? " Mod" : ""));
				});
			});

			// The Investor (exotic mask): grants a bonus per secondary attribute equipped on it,
			// keyed by that attribute's color - +10% Critical Hit Damage per red (O), +5% Skill
			// Efficiency per yellow (U), +1% Armor Regeneration % per blue (D). Always active
			// (the condition - having secondary attributes at all - can't not be true) and
			// scales live with whatever the player has actually picked for those 3 slots.
			const investor = loadout.gear && loadout.gear.Mask && loadout.gear.Mask.name === "Investor" ? loadout.gear.Mask : null;
			if (investor) {
				const perColor = { O: 0, D: 0, U: 0 };
				[investor.attribute1, investor.attribute2, investor.attribute3].forEach((a) => { if (a) perColor[a.Type] = (perColor[a.Type] || 0) + 1; });
				if (perColor.O) add(stats.Offensive, "Critical Hit Damage", perColor.O * 10, "Investor (Slotted)");
				if (perColor.U) add(stats.Utility, "Skill Efficiency", perColor.U * 5, "Investor (Slotted)");
				if (perColor.D) add(stats.Defensive, "Armor Regeneration %", perColor.D * 1, "Investor (Slotted)");
			}

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
							if (t) add(stats[STAT_TYPE_LABEL[t.Type]], found.stat, found.val, brand + " (" + (tier + 1) + "pc)");
							// Skill Tier isn't a plain additive stat — it's derived from how many
							// "cores" contribute to it, same as gear cores, so a brand/gearset tier
							// that grants it must push a core too or the total silently stays at 0.
							if (found.stat === "Skill Tier") stats.Cores.Utility.push(1);
							if (found.stat1 && statsMappingByStat[found.stat1]) {
								buffs.push(found.stat1 + " +" + found.val1);
								const t1 = statsMappingByStat[found.stat1];
								add(stats[STAT_TYPE_LABEL[t1.Type]], found.stat1, found.val1, brand + " (" + (tier + 1) + "pc)");
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
			(loadout.shd || []).forEach((lvl) => { if (lvl.value) add(stats[STAT_TYPE_LABEL[lvl.type]], lvl.name, lvl.value, "SHD Watch"); });

			if (loadout.specialization) {
				["Assault Rifle Damage", "LMG Damage", "Marksman Rifle Damage", "Pistol Damage", "Rifle Damage", "Shotgun Damage", "SMG Damage"]
					.forEach((dmg) => add(stats.Offensive, dmg, 15, "Specialization: " + loadout.specialization.name));
				const spec = DATA.specialization.find((s) => s.name === loadout.specialization.name);
				if (spec) {
					spec.perks.forEach((p) => {
						const t = statsMappingByStat[p.stat];
						if (t) add(stats[STAT_TYPE_LABEL[t.Type]], p.stat, p.val, "Specialization: " + spec.name);
					});
				}
			}

			// Capacitor's Capacitance talent: flat Weapon Damage per point of Skill Tier, always
			// active (not a toggle) - Skill Tier is already capped at 6 by the game, this just
			// re-affirms that cap defensively.
			const capacitorEquipped = ["Primary", "Secondary", "SideArm"].some((k) => loadout.weapons && loadout.weapons[k] && loadout.weapons[k].talent && loadout.weapons[k].talent.Name === "Capacitance");
			if (capacitorEquipped) {
				const tier = Math.min(6, stats.Utility["Skill Tier"] || 0);
				if (tier > 0) add(stats.Offensive, "Weapon Damage", tier * 7.5, "Capacitance (Skill Tier)");
			}

			// Kill Confirmed (Memento, Backpack exotic): +5% Weapon Damage per equipped
			// Offensive (red) core attribute, always active - the separate 30-stack trophy
			// buff is situational, modeled as a toggle in the Damage Projection panel instead.
			if (loadout.gear && loadout.gear.Backpack && loadout.gear.Backpack.name === "Memento") {
				const redCores = gearList.filter((g) => g.core && g.core.Type === "O").length;
				if (redCores > 0) add(stats.Offensive, "Weapon Damage", redCores * 5, "Kill Confirmed (Memento)");
			}

			// shared expertise level (0-30) is the default for every weapon's own expertise -
			// each weapon slot can override it (loadout.weaponExpertise, keyed by slot), same
			// pattern as gear's per-piece expertise. It adds straight into weapon damage %, same
			// weight as a core roll.
			const expertiseLevel = Number(loadout.expertiseLevel || 0);
			const weaponExpertiseMap = loadout.weaponExpertise || {};

			// weapon damage per slot
			function weaponStatsFor(weapon, slotKey) {
				if (!weapon) return null;
				const thisExpertise = weaponExpertiseMap[slotKey] != null ? Number(weaponExpertiseMap[slotKey]) : expertiseLevel;
				const AWD = stats.Cores.Offensive.reduce((a, b) => a + b, 0);
				const core1Contribution = stats.Offensive[weapon.core1.stat] || 0;
				const weaponSpecificDamage = thisExpertise + core1Contribution + rollOf(weapon.core1);
				const genericWeaponDamage = stats.Offensive["Weapon Damage"] || 0;
				const totalPct = AWD + weaponSpecificDamage + genericWeaponDamage;
				const totalDamage = Math.round(weapon.baseDamage * (1 + totalPct / 100));

				function fromGunAndGear(statName) {
					let v = stats.Offensive[statName] || 0;
					if (weapon.core2 && weapon.core2.stat === statName) v += rollOf(weapon.core2);
					if (weapon.attribute1 && weapon.attribute1.Stat === statName) v += rollOf(weapon.attribute1);
					return v;
				}
				const modSlotLabels = { optic: "Optic Mod", underBarrel: "Under Barrel Mod", magazine: "Magazine Mod", muzzle: "Muzzle Mod" };
				const modSlots = [weapon.mods.optic, weapon.mods.underBarrel, weapon.mods.magazine, weapon.mods.muzzle];
				function fromGunMods(statName) {
					let v = 0;
					modSlots.forEach((m) => {
						if (!m) return;
						if (m.pos === statName) v += m.valPos;
						if (m.neg === statName) v += m.valNeg;
					});
					return v;
				}
				// same total as fromGunMods+fromGunAndGear, but also itemizes every contribution
				// (gear/brand/SHD/spec, via stats.Sources, plus this weapon's own core2/attribute1
				// and mods) - for stats where the player might want to know exactly what's adding up
				function explainStat(statName) {
					const sources = (stats.Sources[statName] || []).map((s) => ({ source: s.source, amount: s.amount }));
					Object.entries(weapon.mods).forEach(([slotKey, m]) => {
						if (!m) return;
						if (m.pos === statName) sources.push({ source: modSlotLabels[slotKey], amount: m.valPos });
						if (m.neg === statName) sources.push({ source: modSlotLabels[slotKey], amount: m.valNeg });
					});
					if (weapon.core2 && weapon.core2.stat === statName) sources.push({ source: "Weapon Core 2", amount: rollOf(weapon.core2) });
					if (weapon.attribute1 && weapon.attribute1.Stat === statName) sources.push({ source: "Weapon Attribute", amount: rollOf(weapon.attribute1) });
					const total = sources.reduce((sum, s) => sum + s.amount, 0);
					return { total, sources };
				}
				const hsd = weapon.hsd + fromGunMods("Headshot Damage") + fromGunAndGear("Headshot Damage");
				const chd = 25 + fromGunMods("Critical Hit Damage") + fromGunAndGear("Critical Hit Damage");
				const chcExplain = explainStat("Critical Hit Chance");
				const chc = chcExplain.total;
				const dta = fromGunAndGear("Damage to Armor");
				const dtooc = fromGunAndGear("Damage to TOC");

				// magazine's "Extra Rounds" mod adds flat capacity; reload speed comes from
				// Weapon Handling (any mod slot) plus the magazine's own Reload Speed % tradeoff -
				// gear/SHD Reload Speed % is read once here, not doubled.
				const magazine = weapon.mods.magazine;
				const extraRounds = magazine && magazine.pos === "Extra Rounds" ? magazine.valPos : 0;
				const totalMagSize = weapon.magSize + extraRounds;
				let reloadSpeedPct = fromGunMods("Weapon Handling") + (stats.Offensive["Reload Speed %"] || 0);
				if (magazine && magazine.pos === "Reload Speed %") reloadSpeedPct += magazine.valPos;
				else if (magazine && magazine.neg === "Reload Speed %") reloadSpeedPct += magazine.valNeg;
				const reloadSpeedMs = weapon.reloadSpeedMs / (1 + reloadSpeedPct / 100);

				return {
					weapon, baseDamage: weapon.baseDamage, totalPct, totalDamage, expertiseLevel: thisExpertise,
					hsd, chd, chc, chcSources: chcExplain.sources, dta, dtooc,
					dmgToArmored: Math.round(totalDamage * (1 + dta / 100)),
					dmgToOutOfCover: Math.round(totalDamage * (1 + dtooc / 100)),
					rpm: weapon.rpm, magSize: weapon.magSize, totalMagSize, reloadSpeedMs, reloadSpeedPct,
					AWD, weaponSpecificDamage, genericWeaponDamage,
				};
			}

			const weaponStats = {
				Primary: weaponStatsFor(loadout.weapons && loadout.weapons.Primary, "Primary"),
				Secondary: weaponStatsFor(loadout.weapons && loadout.weapons.Secondary, "Secondary"),
				SideArm: weaponStatsFor(loadout.weapons && loadout.weapons.SideArm, "SideArm"),
			};

			// Each equipped piece contributes its own real base armor (GEAR_SLOT_BASE_ARMOR),
			// scaled 1% per expertise level on that piece's own base only - not the player's
			// innate base, not any core/attribute. Nothing equipped means nothing contributed
			// here at all (no flat floor). Each piece can carry its own expertise level
			// (loadout.gearExpertise, keyed by slot); a slot with no override falls back to the
			// shared expertiseLevel.
			const gearExpertiseMap = loadout.gearExpertise || {};
			const equippedGearEntries = Object.entries(loadout.gear || {}).filter(([, g]) => g);
			const baseArmorNoExpertise = equippedGearEntries.reduce((sum, [key]) => sum + (GEAR_SLOT_BASE_ARMOR[key] || 0), 0);
			const expertiseBaseArmor = equippedGearEntries.reduce((sum, [key]) => {
				const lvl = gearExpertiseMap[key] != null ? Number(gearExpertiseMap[key]) : expertiseLevel;
				return sum + gearPieceArmor(key, lvl);
			}, 0);
			const totals = {
				armor: Math.round((expertiseBaseArmor + stats.Cores.Defensive.reduce((a, b) => a + b, 0)) * (1 + (stats.Defensive["Total Armor"] || 0) / 100)),
				health: stats.Defensive["Health"] || 0,
				skillTier: stats.Utility["Skill Tier"] || 0,
				weaponDamageCores: stats.Cores.Offensive.reduce((a, b) => a + b, 0),
				expertiseLevel, baseArmorLvl40: baseArmorNoExpertise, expertiseBaseArmor,
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
			CORE_ATTRIBUTES, modPool, defaultSHDLevels, SHD_LEVELS_DEF, gearPieceArmor,
			attributePool: (excludeStat) => attributePool(DATA.gearAttributes, excludeStat),
			weaponAttributePool: (excludeStat) => attributePool(DATA.weaponAttributes, excludeStat),
			weaponModPool,
		};
	}

	return { init, defaultSHDLevels, SHD_LEVELS_DEF };
})();
