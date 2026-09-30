/**
 * Reliance vehicle-identity field(s) — shared by the OD and TP orchestrators,
 * since vehicle identity doesn't depend on which cover type is being bought.
 *
 * Reliance's make/model is a single combined Kendo autocomplete field
 * ("VehicleDetailsMakeModel"), unlike National's separate make/model inputs —
 * so this table has no dependsOn cascade (yet). A direct declarative
 * re-expression of the existing call in fullPolicycompany/relianceForm.js:
 *   selectKendoAutocomplete(driver, "VehicleDetailsMakeModel", vehicleSearchText, {...})
 */

const MAKE_MODEL_FIELDS = [
  {
    key: "makeModel",
    label: "Vehicle Make & Model",
    adapter: "kendo",
    kind: "autocomplete",
    locate: () => ({ inputId: "VehicleDetailsMakeModel" }),
    // "tvs scooty zest" matches the fallback already used in relianceForm.js
    // when a job somehow has no vehicleModel — preserved here for parity.
    value: (data) => (data.vehicleModel ? `${data.vehicleMake} ${data.vehicleModel}` : "tvs scooty zest"),
    matchText: (data) => data.vehicleModel || "tvs scooty zest",
    dependsOn: [],
    required: true,
    settleMs: 500,
  },
];

module.exports = { MAKE_MODEL_FIELDS };
