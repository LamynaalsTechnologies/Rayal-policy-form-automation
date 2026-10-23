# Manual real-Chrome checks for the Reliance OD flow

These scripts are **not** part of `npm test` (a unit test never starts a browser — `test/support/noRealWorld.js`). Run them by hand
after changing the OD steps (`multiCompany/common/reliance/relianceOdSteps.js`, `lib/vehicleFuelType.js`, the `[MC] 7-15` lines of
`relianceMultiFormSpec.js`). They need Google Chrome and touch nothing real: no portal, no S3, no database.

| Script | What it proves |
|---|---|
| `node test/manual/odReplica/runFlow.js od` | the whole generated copy, in a real Chrome, against a replica of the Reliance pages: product, TP Details box, Form 60, Validate Customer, vehicle, **Fuel Type**, Get Coverage Details (four late answers that redraw the cover table), Helmet, Nil Depreciation, the **existing TP policy** (panel, number, insurer, two dates), Is Registration Address Same, Calculate Premium, Save, up to the proposal number (the replica has no View Policy page; the script reads the page and ends the run there). Other scenarios: `od-exists`, `od-pa`, `od-lpg`, `od-nofuelbox`, `od-nopetrol`, `od-needprev`, `od-tpcollapsed` (panel starts closed), `od-tpdatefmt` (the picker shows dd/mm/yyyy), `od-tpbaddate` (the page's validator alerts on the end date), `od-tpclear` (the picker empties a dd-mm-yyyy date), `od-tpnoinsurer`, `od-addressticked`, `od-calcrefuse`, `od-saverefuse`, `tp`, `tp-configured` |
| `node test/manual/odReplica/fuelShapes.js` | `selectFuelType` against every plausible shape of the Fuel Type box, and its failure sentences |
| `node test/manual/odReplica/coverWords.js` | the reader of Reliance's own words after a refused Get Coverage Details |
| `node test/manual/odReplica/tpDetailsBox.js` | the TP Details box answers (Yes, No, Proceed once) |

Each prints `PASS` / `FAIL` lines and ends with `RESULT: ALL PASS` (exit code 0) or `RESULT: n FAILED`. The replica is built from what the
owner pasted and from the code's own reading of the full flow — **not** from the live pages, so a pass here means "the code does what it
says on these page shapes", never "Reliance's real OD page works".
