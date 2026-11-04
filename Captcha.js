const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage } = require("@langchain/core/messages");
const axios = require("axios");

// Rayal_backend AutomationLog API — holds the daily captcha-extraction
// counters (one doc per IST day). Set AUTOMATION_LOG_API_URL in .env
const AUTOMATION_LOG_API_URL = (process.env.AUTOMATION_LOG_API_URL || "").trim();

/**
 * Count every Reliance ONLINE-POLICY captcha AI extraction in its own daily
 * counter field (ChaptchaExtracRalienceOnline on the AutomationLog
 * collection). Same endpoint the XL/PDF automations use. Fire-and-forget:
 * a logging failure must never break captcha solving.
 */
function incrementCaptchaCount() {
  if (!AUTOMATION_LOG_API_URL) return;
  axios
    .post(
      `${AUTOMATION_LOG_API_URL}/automationLog/captchaCount`,
      { company: "reliance", flow: "online" },
      { timeout: 5000 }
    )
    .catch((error) => {
      console.error("Failed to increment captcha count:", error.message);
    });
}

module.exports.extractCaptchaText = async (imageUrl) => {
  try {
    // Count this AI extraction attempt in the daily counter
    incrementCaptchaCount();

    // Initialize OpenAI model with vision capabilities
    const model = new ChatOpenAI({
      modelName: "gpt-4o",
      temperature: 0,
      apiKey: process.env.OPENAI_API_KEY,
    });

    // Create message with image
    // Rule-based prompt with the common confusions called out. On saved Reliance
    // captchas the old one-line prompt read RMEF as "RMEE" (8/12 right); this one
    // read all 12 right with the same model and image.
    const message = new HumanMessage({
      content: [
        {
          type: "text",
          text:
            "Read the captcha in this image and return ONLY the characters.\n" +
            "Rules:\n" +
            "- Alphanumeric only (A-Z, a-z, 0-9). No spaces, no punctuation.\n" +
            "- Preserve exact case — do not uppercase or lowercase.\n" +
            "- Typical length is 4 to 8 characters.\n" +
            "- Do NOT include any explanation, prefix, quotes, or the word 'captcha'.\n" +
            "Common confusions — look carefully before choosing:\n" +
            "- 0 (zero) vs O (letter O)\n" +
            "- 1 (one) vs I (letter i) vs l (lowercase L)\n" +
            "- 5 vs S, 8 vs B, 2 vs Z, 6 vs G, 9 vs q\n" +
            "If you are unsure between two characters, pick the more likely one; never return an empty string.",
        },
        {
          type: "image_url",
          image_url: {
            url: imageUrl,
          },
        },
      ],
    });

    // Get response from OpenAI
    const response = await model.invoke([message]);
    const captchaText = response.content.trim();

    return { text: captchaText, success: true };
  } catch (error) {
    console.error("Captcha extraction error:", error);
    return {
      message: error.message,
      success: false,
    };
  }
};
