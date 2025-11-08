// npc-generator.js
// FVTT v12.343 + dnd5e
// 外部化 + 年齡池版：依各種族在 config.json 的年齡參數抽齡；labels 由 TXT 池定義
// 性別依舊在 Background / Biography 的最後一行

import { loadTextFileToArray, loadJSONFile } from "./npc-data-loader.js";


// === SRD 查找工具（內嵌版 | v12+dnd5e 4.4.4） ==========================
const SRDLookup = (() => {
    const _indexCache = new Map();
    const _badPacks = new Set();

    function getConfiguredPacks() {
        try {
            const packs = CFG?.srd?.packs;
            if (Array.isArray(packs) && packs.length) return packs;
        } catch { }
        return ["dnd5e.items", "dnd5e.spells"];
    }
    async function getItemDataByNameWithRules(name, opts = {}) {
        // opts: { allowFuzzy, prefer, requireIdentifier, requireBaseItem, onlyCommon, denyPlus }
        const cfg = {
            allowFuzzy: CFG?.srd?.allowFuzzy !== false,     // 預設 true（相容舊版）
            prefer: CFG?.srd?.prefer || "identifier",       // "identifier" | "baseItem"
            onlyCommon: CFG?.srd?.onlyCommon !== false,     // 預設 true
            denyPlus: CFG?.srd?.denyPlus !== false,         // 預設 true
            ...opts
        };

        const packs = (CFG?.srd?.packs && CFG.srd.packs.length)
            ? CFG.srd.packs : ["dnd5e.items", "dnd5e.spells"];

        // 小工具：依條件過濾候選
        function filterByRules(cands) {
            let list = Array.from(cands || []);
            if (cfg.denyPlus) list = list.filter(x => !isPlusVariant(x?.name));
            if (cfg.onlyCommon) list = list.filter(isNonMagicalBase);
            if (cfg.requireIdentifier) {
                const wantId = normalizeKey(cfg.requireIdentifier);
                list = list.filter(x => normalizeKey(x?.system?.identifier) === wantId);
            }
            if (cfg.requireBaseItem) {
                const wantBase = normalizeKey(cfg.requireBaseItem);
                list = list.filter(x => normalizeKey(x?.system?.baseItem) === wantBase);
            }
            return list;
        }

        // 依偏好欄位選路徑（先 identifier 再 baseItem，或反之）
        const routes = (cfg.prefer === "baseItem")
            ? ["baseItem", "identifier"]
            : ["identifier", "baseItem"];

        for (const p of packs) {
            await ensureIndex(p);
            const idx = _indexCache.get(p);
            if (!idx) continue;

            const rawTarget = String(name || "");
            const english = extractEnglishAlias(rawTarget);
            const baseHumanName = english || rawTarget;
            const wantId = normalizeKey(identifierFromName(baseHumanName));

            let candidates = [];

            for (const route of routes) {
                if (route === "identifier") {
                    const idExact = idx.filter(x => normalizeKey(x?.system?.identifier) === wantId);
                    candidates = filterByRules(idExact);
                    if (candidates.length) break;
                }
                if (route === "baseItem") {
                    const baseMatch = idx.filter(x => normalizeKey(x?.system?.baseItem) === wantId);
                    candidates = filterByRules(baseMatch);
                    if (candidates.length) break;
                }
            }

            // 嚴格路徑沒找到，若開放 allowFuzzy，才嘗試安全別名
            if (!candidates.length && cfg.allowFuzzy) {
                const safe = idx.filter(x => isSafeAlias(rawTarget, x?.name));
                candidates = filterByRules(safe);
            }

            if (!candidates.length) continue;

            // 用你既有的最佳化策略挑一個
            const best = chooseBest(candidates, rawTarget);
            try {
                const comp = game.packs.get(p);
                const doc = await comp.getDocument(best._id);
                if (!doc) continue;
                // 最終再套一次條件
                if (cfg.denyPlus && isPlusVariant(doc.name)) continue;
                if (cfg.onlyCommon && !isNonMagicalBase(doc)) continue;
                return doc.toObject?.() ?? {};
            } catch { /* 試下一個 pack */ }
        }
        return {};
    }
    return { getItemDataByName, getItemDataByNameWithRules };
    async function ensureIndex(pack) {
        if (_indexCache.has(pack) || _badPacks.has(pack)) return;
        const comp = game.packs.get(pack);
        if (!comp) { _badPacks.add(pack); return; }
        if (comp.documentName !== "Item") { _badPacks.add(pack); return; }

        // 關鍵：把 dnd5e 4.4.4 會用到的欄位索引進來
        const idx = await comp.getIndex({
            fields: [
                "name",
                "type",
                "system.identifier", // 例："-spear", "-greatsword"
                "system.baseItem",   // 例："spear", "greatsword"
                "system.rarity"      // 過濾魔法物用
            ]
        });
        _indexCache.set(pack, idx);
    }

    // ============ 名稱 / 識別符 工具 =============
    function normalizeName(s) {
        return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
    }
    function isPlusVariant(s) {
        return /\+\s*\d+/.test(String(s || ""));
    }
    function extractEnglishAlias(raw) {
        // 擷取在地化名中的 [英文] 或 (英文) 作為「原名」
        const str = String(raw || "");
        const m = str.match(/[\[\(（【]\s*([A-Za-z][A-Za-z0-9 '\-]+)\s*[\]\)）】]/);
        return m ? m[1] : null;
    }
    function identifierFromName(name) {
        // "Light Crossbow" → "light-crossbow"; "Chain Shirt" → "chain-shirt"
        return String(name || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "");
    }
    function normalizeKey(s) {
        return String(s || "")
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "")
            .replace(/^-+/, ""); // 去掉前導 "-"
    }
    function isNonMagicalBase(entry) {
        const r = (entry?.system?.rarity || "").toLowerCase();
        // 稀有度空/ common 視為非魔法；名稱禁止 +數字
        return (!r || r === "common") && !isPlusVariant(entry?.name);
    }
    function isSafeAlias(baseName, candidateName) {
        // 僅允許：完全相等 或 「基底 + (…)/(…) 或 […]/[…]」註記
        const b = normalizeName(baseName);
        const c = normalizeName(candidateName);
        if (c === b) return true;
        if (isPlusVariant(candidateName)) return false;
        if (!c.startsWith(b)) return false;
        const suffix = c.slice(b.length);
        return /^\s*[\[(（【].*[\])）】]\s*$/.test(suffix);
    }

    function chooseBest(cands, wantName) {
        // 1) 非魔法基底優先
        let list = cands.filter(isNonMagicalBase);
        if (!list.length) list = cands.slice();

        // 2) 名稱為安全別名者優先
        let best = list.find(x => isSafeAlias(wantName, x?.name));
        if (best) return best;

        // 3) 單一候選或回退第一個
        return list[0] || null;
    }

    function findByName(idx, name) {
        if (!name) return null;
        const rawTarget = String(name);
        const lowerTarget = normalizeName(rawTarget);

        // A) 先試「安全別名」等名（處理本地化 + [英名]）
        let hit = idx.find(x => x?.name === rawTarget);
        if (hit && isSafeAlias(rawTarget, hit.name)) return hit;

        hit = idx.find(x => normalizeName(x?.name) === lowerTarget);
        if (hit && isSafeAlias(rawTarget, hit.name)) return hit;

        // B) 用 [英名] 提示產生識別符（若存在）
        const english = extractEnglishAlias(rawTarget);
        const baseHumanName = english || rawTarget;              // 優先用英名
        const wantId = normalizeKey(identifierFromName(baseHumanName)); // 例："Shortbow"→"shortbow"

        // B1) 直接比對 system.identifier（允許有或沒有前導 "-"）
        const idExact = idx.filter(x => {
            const id = normalizeKey(x?.system?.identifier);
            return id && (id === wantId);
        });
        if (idExact.length) {
            const best = chooseBest(idExact, rawTarget);
            if (best) return best;
        }

        // B2) 若 identifier 沒命中，用 baseItem 比對，但需嚴格過濾掉變體：
        //     - baseItem 等於 wantId
        //     - 非魔法（避免 Vicious / +1 等）
        //     - 名稱需通過安全別名，避免抓到「不同東西但同基底」的魔改
        const baseMatch = idx.filter(x => {
            const base = normalizeKey(x?.system?.baseItem);
            return base && base === wantId && isNonMagicalBase(x) && isSafeAlias(rawTarget, x?.name);
        });
        if (baseMatch.length) {
            const best = chooseBest(baseMatch, rawTarget);
            if (best) return best;
        }

        // C) 最後保守回退：只允許「基底名 + 括號註記」
        const safeAlias = idx.find(x => isSafeAlias(rawTarget, x?.name));
        if (safeAlias) return safeAlias;

        return null;
    }

    async function getItemDataByName(name) {
        const packs = getConfiguredPacks();
        for (const p of packs) {
            await ensureIndex(p);
            const idx = _indexCache.get(p);
            if (!idx) continue;

            const hit = findByName(idx, name);
            if (!hit) continue;

            try {
                const comp = game.packs.get(p);
                const doc = await comp.getDocument(hit._id);

                // 防呆：再檢一次
                if (!doc || !isNonMagicalBase(doc) || !isSafeAlias(name, doc.name)) {
                    continue;
                }
                return doc?.toObject?.() ?? {};
            } catch {
                // ignore and try next pack
            }
        }
        return {};
    }

    return { getItemDataByName };
})();

// =====================================================================

/* ========================
 * 全域狀態（由外部載入）
 * ======================== */
let CFG = null;

let FIRST_NAMES = [];
let LAST_NAMES = [];
let BACKGROUND_STORIES = [];
let PERSONALITIES = [];
let QUIRKS = [];
let GENDERS = [];

let APP_BUILDS = [];
let APP_HAIR_COLORS = [];
let APP_EYE_COLORS = [];
let APP_MARKS = [];
let RACE_FLAVOR = new Map(); // raceId -> string[]

let NPC_GEAR = {};
let NPC_SPELLS = {};

let RACES = []; // from config
let TYPES = []; // from config

// 年齡分桶顯示名稱（從 TXT 載入；例如 young=青年）
let AGE_LABELS = new Map(); // bucketId -> label string

/* ========================
 * 工具
 * ======================== */
// 安全載入文字清單
async function safeLoadArray(path, fallback = []) {
    try {
        const arr = await loadTextFileToArray(path);
        return (Array.isArray(arr) && arr.length) ? arr : fallback;
    } catch (e) {
        console.warn(`NPC Generator | 無法載入：${path}，改用 fallback`, e);
        return fallback;
    }
}

// 將形如 "key=value" 的 TXT 轉字典
async function loadKeyValueTxt(path) {
    const lines = await safeLoadArray(path, []);
    const map = new Map();
    for (const raw of lines) {
        const line = String(raw).trim();
        if (!line || line.startsWith("#")) continue;
        const idx = line.indexOf("=");
        if (idx === -1) continue;
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim();
        if (key) map.set(key, val);
    }
    return map;
}

// 從陣列隨機取一個
function pick(arr, or = null) {
    if (!Array.isArray(arr) || arr.length === 0) return or;
    return arr[Math.floor(Math.random() * arr.length)];
}

// 權重隨機
function weightedPick(items) {
    // items: [{id, range:[min,max], weight}]
    const total = items.reduce((s, it) => s + (Number(it.weight) || 0), 0);
    if (!total) return pick(items, null);
    let r = Math.random() * total;
    for (const it of items) {
        r -= (Number(it.weight) || 0);
        if (r <= 0) return it;
    }
    return items[items.length - 1] || null;
}

/* ========================
 * 初始化：載入 config 與外部檔案
 * ======================== */
Hooks.once("init", async function () {
    console.log("NPC Generator | Module initializing...");

    try {
        // 1) config
        CFG = await loadJSONFile("modules/npc-generator/data/config/config.json");
        if (!CFG) throw new Error("找不到 config/config.json");

        // 2) 基本資料池
        const P = CFG.paths;
        [
            FIRST_NAMES,
            LAST_NAMES,
            BACKGROUND_STORIES,
            PERSONALITIES,
            QUIRKS,
            GENDERS
        ] = await Promise.all([
            safeLoadArray(P.firstNames, ["Alex"]),
            safeLoadArray(P.lastNames, ["Smith"]),
            safeLoadArray(P.backgrounds, ["來自平凡家庭，行走四方。"]),
            safeLoadArray(P.personalities, []),
            safeLoadArray(P.quirks, []),
            safeLoadArray(P.genders, ["不分性別"])
        ]);

        // 3) 外觀池
        const A = CFG.paths.appearance;
        [
            APP_BUILDS,
            APP_HAIR_COLORS,
            APP_EYE_COLORS,
            APP_MARKS
        ] = await Promise.all([
            safeLoadArray(A.builds, ["普通身形"]),
            safeLoadArray(A.hairColors, ["黑髮"]),
            safeLoadArray(A.eyeColors, ["黑眸"]),
            safeLoadArray(A.marks, ["衣著整潔"])
        ]);

        // 4) 裝備/法術
        [NPC_GEAR, NPC_SPELLS] = await Promise.all([
            loadJSONFile(P.gear),
            loadJSONFile(P.spells)
        ]);

        // 5) 種族/類型
        RACES = Array.isArray(CFG.races) ? CFG.races : [];
        TYPES = Array.isArray(CFG.types) ? CFG.types : [];

        // 5a) 種族風味
        RACE_FLAVOR.clear();
        for (const r of RACES) {
            const file = (r && r.raceFlavorFile) ? (CFG.paths.appearance.raceFlavorDir + r.raceFlavorFile) : null;
            const flavor = file ? await safeLoadArray(file, []) : [];
            RACE_FLAVOR.set(r.id, flavor);
        }

        // 6) 年齡分桶顯示名稱
        AGE_LABELS = await loadKeyValueTxt(CFG.paths.ages.labels);

        console.log("NPC Generator | All data loaded.");
    } catch (err) {
        console.error("NPC Generator | Data load error:", err);
        ui.notifications?.error(`NPC 資料載入失敗：${err.message}`);
    }

    // 暴露 API
    window.npcGenerator = npcGenerator;
});

Hooks.once("ready", async function () {
    console.log("NPC Generator | Module ready. 輸入 /npc 生成 NPC。");
});

/* ========================
 * 組裝邏輯
 * ======================== */
// 隨機能力值（8~18）
function randomAbilityScore() {
    return Math.floor(Math.random() * 11) + 8;
}

// 依種族加值
function applyRaceAbilityBonus(abilities, raceEntry) {
    const bonus = raceEntry?.abilityBonuses || {};
    for (const [k, v] of Object.entries(bonus)) {
        if (typeof abilities[k] === "number") abilities[k] += Number(v) || 0;
    }
    return abilities;
}

// 名字
function buildFullName() {
    const first = pick(FIRST_NAMES, "Alex");
    const last = pick(LAST_NAMES, "Smith");
    return `${first} ${last}`;
}

// 性別
function pickGender() {
    return pick(GENDERS, "不分性別");
}

// 長相（外部池 + 種族風味）
function buildAppearance(raceId) {
    const parts = [
        pick(APP_BUILDS, "普通身形"),
        pick(APP_HAIR_COLORS, "黑髮"),
        pick(APP_EYE_COLORS, "黑眸"),
        pick(APP_MARKS, "衣著整潔")
    ];
    const flavor = RACE_FLAVOR.get(raceId) || [];
    if (flavor.length) {
        parts.push(pick(flavor));
        if (Math.random() > 0.6 && flavor.length > 1) parts.push(pick(flavor));
    }
    return `長相：${parts.join("、")}。`;
}

// ★ 年齡（依種族設定抽樣；回傳 {age, bucketId, label} ）
// - 先用 buckets 權重選一個分桶，再在該 range 內均勻取整數
// - label 由 ages/labels.txt 映射（找不到時就用 bucketId）
function pickAgeForRace(raceId) {
    const r = RACES.find(x => x.id === raceId);
    const ageCfg = r?.age;
    if (!ageCfg) return { age: null, bucketId: null, label: null };

    const buckets = Array.isArray(ageCfg.buckets) ? ageCfg.buckets : [];
    const chosen = weightedPick(buckets) || null;
    let age = null, bucketId = null, label = null;

    if (chosen && Array.isArray(chosen.range) && chosen.range.length === 2) {
        const min = Math.max(ageCfg.min ?? chosen.range[0], chosen.range[0]);
        const max = Math.min(ageCfg.max ?? chosen.range[1], chosen.range[1]);
        if (min <= max) {
            age = Math.floor(Math.random() * (max - min + 1)) + min;
            bucketId = chosen.id || null;
        }
    }

    if (bucketId) {
        label = AGE_LABELS.get(bucketId) || bucketId;
    }
    return { age, bucketId, label };
}

// 傳記/背景（★ 年齡置於倒數第二行；性別最後）
function buildTexts(raceId) {
    const gender = pickGender();
    const bg = pick(BACKGROUND_STORIES, "來自平凡家庭，行走四方。");
    const per = pick(PERSONALITIES, null);
    const q = pick(QUIRKS, null);
    const ap = buildAppearance(raceId);

    const { age, label: ageLabel } = pickAgeForRace(raceId);
    const ageLine = (age != null)
        ? `年齡：${age}${ageLabel ? `（${ageLabel}）` : ""}`
        : null;

    // Background（純文字）— 性別最後
    const lines = [
        `背景：${bg}`,
        per ? `個性：${per}` : null,
        q ? `怪癖：${q}` : null,
        ap,
        ageLine,                 // ← 年齡倒數第二
        `性別：${gender}`        // ← 性別最後
    ].filter(Boolean);
    const backgroundPlain = lines.join("\n");

    // Biography（HTML）— 同樣性別最後
    const biographyHTML = `
    <p><strong>背景：</strong>${bg}</p>
    ${per ? `<p><strong>個性：</strong>${per}</p>` : ""}
    ${q ? `<p><strong>怪癖：</strong>${q}</p>` : ""}
    <p>${ap}</p>
    ${ageLine ? `<p><strong>${ageLine.split("：")[0]}：</strong>${ageLine.split("：")[1]}</p>` : ""}
    <p><strong>性別：</strong>${gender}</p>
  `;

    return { biographyHTML, backgroundPlain };
}

// 裝備 + 法術
async function buildItemsByType(typeId) {
    const gear = Array.isArray(NPC_GEAR?.[typeId]) ? NPC_GEAR[typeId] : [];
    const spells = Array.isArray(NPC_SPELLS?.[typeId]) ? NPC_SPELLS[typeId] : [];
    const entries = [...gear, ...spells];

    const srdEnabled = CFG?.srd?.enabled !== false;            // 預設啟用
    const fallback = (CFG?.srd?.fallback || "empty").toLowerCase(); // "empty" | "inline"
    const cat = CFG?.categories || {};
    const out = [];

    for (const e of entries) {
        // 1) 來源名稱（字串或物件）
        const name = (typeof e === "string") ? e : (e?.srdName || e?.name || e?.id || "");
        const type = (typeof e === "object") ? (e.type || "") : "";

        // 2) 先看此類別是否允許抓 SRD
        const typeFlag =
            (type === "weapon" && cat.weapon) ||
            (type === "equipment" && cat.equipment) ||
            (type === "shield" && cat.shield) ||
            (type === "spell" && cat.spell);

        // 3) 準備規則（全域 + 條目級覆寫）
        const rules = Object.assign({}, e?.srdRules || {});
        // 若條目沒寫，使用全域預設（在 getItemDataByNameWithRules 裡面也會再補一次）
        // 這裡可選擇顯式寫入，方便除錯觀察：
        if (rules.allowFuzzy == null) rules.allowFuzzy = CFG?.srd?.allowFuzzy !== false;
        if (!rules.prefer) rules.prefer = CFG?.srd?.prefer || "identifier";
        if (rules.onlyCommon == null) rules.onlyCommon = CFG?.srd?.onlyCommon !== false;
        if (rules.denyPlus == null) rules.denyPlus = CFG?.srd?.denyPlus !== false;

        let data = {};

        if (srdEnabled && typeFlag && name) {
            // ★ 有條件地抓 SRD
            data = await SRDLookup.getItemDataByNameWithRules(name, rules);
        }

        if (!data || Object.keys(data).length === 0) {
            // SRD 沒命中或被規則排除 → 依 fallback 策略
            if (fallback === "inline" && e && typeof e === "object" && Object.keys(e).length > 1) {
                out.push(e);          // 用你在清單內的「內嵌定義」
            } else {
                out.push({});         // 或者留空，由 NPC 建立後再補
            }
            continue;
        }

        // 命中 SRD：套用覆寫
        if (e && typeof e === "object") {
            if (e.overrideName) data.name = e.overrideName;
            if (e.system && typeof e.system === "object") {
                data.system = Object.assign({}, data.system || {}, e.system);
            }
            if (Number.isFinite(e.quantity)) {
                data.system = Object.assign({}, data.system || {}, { quantity: e.quantity });
            }
        }

        out.push(data);
    }

    return out;
}

// 類型參數
function getTypeParams(typeId) {
    const t = TYPES.find(x => x.id === typeId);
    return {
        cr: t?.cr ?? 0,
        xp: t?.xp ?? 0,
        skills: t?.skills ?? {},
        extraLanguages: t?.extraLanguages ?? []
    };
}

// 種族參數
function getRaceParams(raceId) {
    const r = RACES.find(x => x.id === raceId);
    return {
        speed: r?.speed ?? 30,
        languages: Array.isArray(r?.languages) ? r.languages : ["common"],
        entry: r
    };
}

/* ========================
 * 產生器主流程
 * ======================== */
const npcGenerator = {
    async createRandomNPC() {
        try {
            if (!CFG) throw new Error("配置尚未載入");

            const raceId = pick(RACES.map(r => r.id), "Human");
            const typeId = pick(TYPES.map(t => t.id), "Commoner");

            const { speed, languages: raceLangs, entry: raceEntry } = getRaceParams(raceId);
            const { cr, xp, skills, extraLanguages } = getTypeParams(typeId);

            let abilities = {
                str: randomAbilityScore(),
                dex: randomAbilityScore(),
                con: randomAbilityScore(),
                int: randomAbilityScore(),
                wis: randomAbilityScore(),
                cha: randomAbilityScore()
            };
            applyRaceAbilityBonus(abilities, raceEntry);

            const { biographyHTML, backgroundPlain } = buildTexts(raceId);
            const items = await buildItemsByType(typeId);
            const hp = Math.floor(Math.random() * 20) + 10; // 10~30
            const ac = Math.floor(Math.random() * 5) + 10;
            const languages = Array.from(new Set([...(raceLangs || []), ...(extraLanguages || [])]));

            const fullName = buildFullName();
            const newActorData = {
                name: `${fullName} (${typeId}, ${raceId})`,
                type: "npc",
                items,
                system: {
                    details: {
                        type: { value: "humanoid", subtype: raceId },
                        alignment: "neutral",
                        race: raceId,
                        cr,
                        xp: { value: xp },
                        biography: { value: biographyHTML }, // HTML（性別在最後）
                        background: backgroundPlain          // 純文字（性別在最後）
                    },
                    abilities: {
                        str: { value: abilities.str },
                        dex: { value: abilities.dex },
                        con: { value: abilities.con },
                        int: { value: abilities.int },
                        wis: { value: abilities.wis },
                        cha: { value: abilities.cha }
                    },
                    attributes: {
                        hp: { value: hp, max: hp },
                        ac: { value: ac },
                        movement: { walk: speed }
                    },
                    skills,
                    traits: {
                        languages: { value: languages, custom: "" }
                    }
                }
            };

            const newActor = await Actor.create(newActorData, { strict: true });
            ui.notifications?.info(`已建立 NPC：${newActor.name}`);
            console.log("NPC Generator | 新建 NPC：", newActor);
            return newActor;
        } catch (err) {
            console.error("NPC Generator | 建立失敗：", err);
            ui.notifications?.error(`NPC 建立失敗：${err.message}`);
        }
    }
};

// 聊天指令：/npc
Hooks.on("chatMessage", (chatLog, message) => {
    if (message.trim().toLowerCase() === "/npc") {
        npcGenerator.createRandomNPC();
        return false;
    }
    return true;
});
