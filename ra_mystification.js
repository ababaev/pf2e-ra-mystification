/*
 * PF2e RA Mystification — a Foundry VTT macro for disguising items
 * Copyright (C) 2026  Arkady Babaev <https://github.com/ababaev>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 * The full licence text is also available at
 * <https://www.gnu.org/licenses/gpl-3.0.html> and in the COPYING file
 * distributed with this program.
 *
 * ---------------------------------------------------------------------
 * WHAT IT DOES
 *   Drop an item into the window, pick something to disguise it as, and
 *   the script fills the item's "Mystified" tab (name, image, description).
 *
 * REQUIREMENTS
 *   Foundry VTT v13 or later (uses DialogV2).
 *   The Pathfinder Second Edition system module, which this macro depends
 *   on: candidates are read at runtime from its bundled compendiums.
 *   Macro type: script.
 *
 * THIRD-PARTY CONTENT
 *   This macro reads game content from the PF2e system's compendiums at
 *   runtime. It does not contain or redistribute any Paizo content. Names,
 *   images and descriptions remain the property of their respective owners
 *   and are used here only within the user's own game world. Paizo game
 *   content is used under the Open Game License / ORC as applicable to the
 *   PF2e system module; this macro is not affiliated with or endorsed by
 *   Paizo Inc.
 */

(async () => {
  // ============ НАСТРОЙКИ ============
  const PACKS      = ["pf2e.equipment-srd"]; // можно добавить свои компендиумы
  const CATEGORIES = ["potion", "elixir", "talisman"];
  const TOLERANCE  = 0.25;  // ±25% — полоса поиска при совпадении по цене
  const LEVEL_SPAN = 1;     // ±1 уровень — полоса при совпадении по уровню
  const MAX        = 15;    // сколько вариантов показывать
  const SET_STATUS = false; // true — сразу мистифицировать;
                            // false — только подготовить маскировку
  // ===================================

  // --- вспомогательные ---
  const cp = (price) => {
    const v = price?.value;
    if (!v) return null;                       // цены нет → исключаем
    const per = price?.per ?? 1;
    const total = (v.pp ?? 0) * 1000 + (v.gp ?? 0) * 100
                + (v.sp ?? 0) * 10  + (v.cp ?? 0);
    return total / per;
  };

  const catOf = (sys) => sys?.category ?? sys?.consumableType?.value ?? null;

  const fmt = (c) => {
    if (c === null) return "—";
    const gp = c / 100;
    return Number.isInteger(gp) ? `${gp} gp` : `${gp.toFixed(2)} gp`;
  };

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // --- 1. окно с приёмом перетаскивания ---
  const item = await new Promise((resolve) => {
    let done = false;
    const dlg = new foundry.applications.api.DialogV2({
      window: { title: "Мистификация — перетащи предмет" },
      content: `
        <div id="myst-drop" style="border:2px dashed #888;padding:2.5rem;
             text-align:center;border-radius:6px;opacity:.85;">
          Перетащи сюда предмет
        </div>`,
      buttons: [{ action: "cancel", label: "Отмена" }],
      close: () => { if (!done) resolve(null); }
    });

    dlg.render(true).then(() => {
      const el = dlg.element.querySelector("#myst-drop");
      el.addEventListener("dragover", (ev) => {
        ev.preventDefault();
        el.style.background = "rgba(120,160,255,.15)";
      });
      el.addEventListener("dragleave", () => { el.style.background = ""; });
      el.addEventListener("drop", async (ev) => {
        ev.preventDefault();
        el.style.background = "";
        try {
          const data = JSON.parse(ev.dataTransfer.getData("text/plain"));
          const doc  = await fromUuid(data.uuid);
          if (!doc) throw new Error("no doc");
          done = true;
          resolve(doc);
          dlg.close();
        } catch (e) {
          ui.notifications.error("Не удалось прочитать перетащенный предмет");
        }
      });
    });
  });

  if (!item) return;

  if (!item.isOwner)
    return ui.notifications.error("Нет прав на изменение этого предмета");

  const cat = catOf(item.system);
  if (!CATEGORIES.includes(cat))
    return ui.notifications.warn(
      `Категория "${cat ?? "—"}" пока не поддерживается. ` +
      `Поддерживаются: ${CATEGORIES.join(", ")}`);

  const targetPrice = cp(item.system.price);
  const targetLevel = item.system.level?.value ?? null;

  if (targetPrice === null && targetLevel === null)
    return ui.notifications.error("У предмета нет ни цены, ни уровня");

  // --- 2. собираем кандидатов из компендиумов ---
  const pool = [];
  for (const key of PACKS) {
    const pack = game.packs.get(key);
    if (!pack) { ui.notifications.warn(`Компендиум ${key} не найден`); continue; }
    const index = await pack.getIndex({ fields: [
      "type", "img", "system.price", "system.category",
      "system.consumableType", "system.level"
    ]});
    for (const e of index) {
      if (e.type !== "consumable") continue;
      if (catOf(e.system) !== cat)  continue;
      if (e.name === item.name)     continue;
      pool.push({
        _id: e._id,
        pack: key,
        name: e.name,
        img: e.img,
        price: cp(e.system.price),
        level: e.system?.level?.value ?? null
      });
    }
  }

  if (!pool.length)
    return ui.notifications.warn("В компендиумах нет предметов этой категории");

  // --- 3. три режима подбора ---
  const buildByPrice = () => {
    if (targetPrice === null) return [];
    const scored = pool.filter((x) => x.price !== null);
    const exact  = scored.filter((x) => x.price === targetPrice);
    const near   = scored
      .filter((x) => x.price !== targetPrice
                  && x.price >= targetPrice * (1 - TOLERANCE)
                  && x.price <= targetPrice * (1 + TOLERANCE))
      .sort((a, b) => Math.abs(a.price - targetPrice)
                    - Math.abs(b.price - targetPrice));
    return [...exact, ...near];
  };

  const buildByLevel = () => {
    if (targetLevel === null) return [];
    return pool
      .filter((x) => x.level !== null
                  && Math.abs(x.level - targetLevel) <= LEVEL_SPAN)
      .sort((a, b) => Math.abs(a.level - targetLevel)
                    - Math.abs(b.level - targetLevel));
  };

  const buildBoth = () => {
    const priceIds = new Set(buildByPrice().map((x) => x._id));
    return buildByLevel().filter((x) => priceIds.has(x._id));
  };

  const build = (mode) => {
    const list = mode === "price" ? buildByPrice()
               : mode === "level" ? buildByLevel()
               : buildBoth();
    return list.slice(0, MAX);
  };

  // --- 4. окно выбора ---
  const badge = (x) => {
    const bits = [];
    if (x.price !== null) {
      if (targetPrice !== null && x.price === targetPrice) bits.push("цена точная");
      else if (targetPrice) {
        const d = Math.round((x.price / targetPrice - 1) * 100);
        bits.push(`${d > 0 ? "+" : ""}${d}%`);
      }
    }
    if (x.level !== null) {
      const d = targetLevel === null ? null : x.level - targetLevel;
      bits.push(d === 0 || d === null ? `ур. ${x.level}`
                                      : `ур. ${x.level} (${d > 0 ? "+" : ""}${d})`);
    }
    return bits.join(" · ");
  };

  const renderList = (mode) => {
    const list = build(mode);
    if (!list.length)
      return `<p style="opacity:.7;padding:1rem 0;">Ничего не найдено в этом режиме.</p>`;
    return list.map((x, i) => `
      <label style="display:flex;gap:.5rem;align-items:center;
                    padding:.3rem .2rem;border-bottom:1px solid rgba(128,128,128,.2);">
        <input type="radio" name="pick" value="${i}" ${i ? "" : "checked"}>
        <img src="${esc(x.img)}" width="30" height="30" style="border:none;flex:0 0 auto;">
        <span style="flex:1 1 auto;">${esc(x.name)}</span>
        <span style="opacity:.65;font-size:.85em;white-space:nowrap;">
          ${esc(fmt(x.price))} · ${esc(badge(x))}
        </span>
      </label>`).join("");
  };

  const header = `
    <p style="opacity:.75;margin:0 0 .5rem 0;">
      <b>${esc(item.name)}</b> — ${esc(fmt(targetPrice))}${
        targetLevel !== null ? `, уровень ${targetLevel}` : ""}
    </p>
    <div style="display:flex;gap:1rem;margin-bottom:.5rem;">
      <label><input type="radio" name="mode" value="price" checked> по цене</label>
      <label><input type="radio" name="mode" value="level"> по уровню</label>
      <label><input type="radio" name="mode" value="both"> и то, и другое</label>
    </div>`;

  let currentMode = "price";

  const picked = await new Promise((resolve) => {
    let done = false;
    const dlg = new foundry.applications.api.DialogV2({
      window: { title: `Чем замаскировать: ${item.name}`, resizable: true },
      position: { width: 520 },
      content: `${header}<div id="myst-list"
                   style="max-height:420px;overflow:auto;">${renderList("price")}</div>`,
      buttons: [
        { action: "ok", label: "Применить", default: true,
          callback: (ev, btn) => {
            const sel = btn.form.elements.pick;
            if (!sel) return null;
            const idx = Number(sel.value);
            done = true;
            return build(currentMode)[idx] ?? null;
          }},
        { action: "cancel", label: "Отмена", callback: () => null }
      ],
      submit: (result) => resolve(result ?? null),
      close: () => { if (!done) resolve(null); }
    });

    dlg.render(true).then(() => {
      const root = dlg.element;
      root.querySelectorAll('input[name="mode"]').forEach((r) => {
        r.addEventListener("change", (ev) => {
          currentMode = ev.target.value;
          root.querySelector("#myst-list").innerHTML = renderList(currentMode);
        });
      });
    });
  });

  if (!picked) return;

  // --- 5. применяем маскировку ---
  const pack = game.packs.get(picked.pack);
  const fake = await pack.getDocument(picked._id);
  if (!fake) return ui.notifications.error("Не удалось загрузить выбранный предмет");

  await item.update({
    "system.identification.unidentified.name": fake.name,
    "system.identification.unidentified.img": fake.img,
    "system.identification.unidentified.data.description.value":
      fake.system.description?.value ?? ""
  });

  if (SET_STATUS) {
    await item.update({ "system.identification.status": "unidentified" });
    ui.notifications.info(`${item.name} мистифицирован под "${fake.name}"`);
  } else {
    ui.notifications.info(
      `Маскировка готова: ${item.name} → "${fake.name}". Мистифицируй вручную.`);
  }
})();