const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");
const { checkBriskWallet } = require("../briskCertificate");

const withWalletResponse = async (response, run) => {
  const originalGet = axios.get;
  axios.get = response;
  try {
    await run();
  } finally {
    axios.get = originalGet;
  }
};

test("Brisk wallet lookup error refuses certificate creation", async () => {
  await withWalletResponse(
    async () => ({ data: { error: true, message: "Something went wrong!!!" } }),
    async () => {
      const result = await checkBriskWallet(177, "job");
      assert.equal(result.ok, false);
      assert.equal(result.balance, null);
      assert.match(result.reason, /Could not verify Brisk wallet balance/);
    }
  );
});

test("Brisk wallet lookup network error refuses certificate creation", async () => {
  await withWalletResponse(
    async () => {
      throw new Error("socket hang up");
    },
    async () => {
      const result = await checkBriskWallet(177, "job");
      assert.equal(result.ok, false);
      assert.equal(result.balance, null);
      assert.match(result.reason, /socket hang up/);
    }
  );
});

test("a verified Brisk wallet balance is compared with the certificate premium", async () => {
  await withWalletResponse(
    async () => ({ data: { data: { balance: 200 } } }),
    async () => {
      assert.deepEqual(await checkBriskWallet(177), {
        ok: true,
        balance: 200,
        reason: null,
      });
    }
  );
  await withWalletResponse(
    async () => ({ data: { balance: 100 } }),
    async () => {
      const result = await checkBriskWallet(177);
      assert.equal(result.ok, false);
      assert.equal(result.balance, 100);
      assert.match(result.reason, /Insufficient Brisk wallet balance/);
    }
  );
});
