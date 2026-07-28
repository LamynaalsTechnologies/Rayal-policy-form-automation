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
    const message = new HumanMessage({
      content: [
        {
          type: "text",
          text: "Extract the text from this captcha image. Return only the text you see, nothing else. If the captcha contains alphabetic characters, return them exactly as they appear.",
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
