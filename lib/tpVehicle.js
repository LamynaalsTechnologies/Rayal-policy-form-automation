/**
 * The vehicle keys a TP job must carry when the policy was sold from a Combined
 * Make & Model: the TP insurer's OWN make / model / variant / CC, not the OD
 * insurer's. The policy's top-level vehicle fields are the OD vehicle, so an OD
 * job (and a single-company job) needs no change.
 *
 * NO requires on purpose: the automation server (Rayal-policy-form-automation,
 * lib/partRunner.js) applies the same overlay to a TP part and keeps a
 * byte-identical copy of this file, like shared/jobPartsCore.js — change both
 * together (`cmp` them).
 *
 * `idv`, `idvRangeFrom` and `idvRangeTo` are NOT overlaid: the IDV is the OD
 * side's, the TP premium does not depend on it.
 *
 * @param {object|null} tpVehicle the policy's `tpVehicle` snapshot
 * @returns {object} keys to assign over the job's form data ({} when there is none)
 */
const tpVehicleOverrides = (tpVehicle) => {
  if (!tpVehicle || typeof tpVehicle !== "object") return {};
  const out = {};
  const set = (key, value) => {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  };
  set("vehicleMake", tpVehicle.vehicleMake);
  set("vehicleModel", tpVehicle.vehicleModel);
  set("vehicleCC", tpVehicle.vehicleCC);
  // The variant and the model-not-found flag may legitimately be "" / false, and
  // must then REPLACE the OD vehicle's value rather than leave it behind.
  out.vehicleVariant = tpVehicle.vehicleVariant || "";
  out.modelNotFound = !!tpVehicle.modelNotFound;
  out.manufacturerSellingPrice =
    Number.isFinite(Number(tpVehicle.manufacturerSellingPrice)) && Number(tpVehicle.manufacturerSellingPrice) > 0
      ? Number(tpVehicle.manufacturerSellingPrice)
      : undefined;
  return out;
};

module.exports = { tpVehicleOverrides };
