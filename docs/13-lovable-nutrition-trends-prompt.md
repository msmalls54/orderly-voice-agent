# Lovable prompt — Nutrition Trends

Add a new read-only tab to the existing Orderly app called **Nutrition Trends**. Preserve every existing page, route, order function, checkout function, authentication setting, and visual style. This tab is an optional dashboard for a caregiver, senior-center staff member, or judge; the senior never needs to open it to place an order.

Requirements:

1. Add **Nutrition Trends** to navigation and create a responsive `/nutrition-trends` page.
2. Place a prominent **Synthetic demo data** badge beside the title and show this exact disclosure: “This prototype uses fictional people and estimated nutrition data to demonstrate future tracking. It does not provide medical advice, verify allergens, or change food orders.”
3. Use three clearly fictional profiles: Evelyn Parker, 74, with Type 2 diabetes context; George Bennett, 79, with high blood pressure context; and Rosa Martinez, 72, with peanut allergy context.
4. Keep deterministic placeholder records in a small local file such as `demoNutritionData.ts`. Label every chart, card, and meal record **Demo estimate — not verified nutrition facts**. Do not claim restaurant data is authoritative or compare values with clinical limits.
5. Add a simple in-memory profile selector. Do not save or transmit profile data.
6. Show four large seven-day overview cards: Protein, Carbohydrates, Fiber, and Sodium. Each shows a synthetic average and a neutral direction: up, down, or steady. Never label a result healthy, unhealthy, safe, dangerous, good, or bad.
7. Add two simple chart sections: **Macros over time** for protein, carbohydrates, and fat; and **Micronutrient estimates** for sodium, potassium, calcium, iron, vitamin D, and vitamin B12. Users can show or hide series. Display visible units and a seven-day range.
8. Put an accessible text/table version of the same data under each chart.
9. Add a compact **Recent meals** table with date, restaurant, ordered items, and a Demo estimate label. Use synthetic meals only.
10. Add a **Context to keep in mind** card with neutral language: “Context only — not a diagnosis or recommendation.” For Rosa, add: “Peanut allergy is listed. Ingredient and cross-contact information has not been verified; confirm directly with the restaurant.” Never claim any food is allergen-safe.
11. Add a **Future concept** section with: spot patterns across repeated orders; help caregivers discuss preferences and routines; connect verified restaurant nutrition data later.
12. This tab must never block, approve, alter, submit, or cancel an order. Include no checkout buttons, API keys, real personal data, medical records, or external service calls.
13. Make it senior-friendly: minimum 18px body text, generous spacing, large controls, strong contrast, keyboard navigation, visible focus states, direct chart labels, and no meaning communicated by color alone.
14. Match the existing Orderly design. Avoid gradients, glassmorphism, neon, generic AI imagery, medical imagery, or dashboard clutter. Use the app’s palette; otherwise use restrained off-white, navy, and teal.
15. Keep this intentionally small: use the existing chart library if present, otherwise lightweight SVG/CSS. Add basic empty/error states and no backend.

Acceptance: the tab is clearly separate and read-only; all data is fictional and labeled; macro and micronutrient views have accessible tables; health conditions/allergies are caution context only; existing phone/order behavior remains untouched.
