const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage } = require("@langchain/core/messages");

module.exports.extractCaptchaText = async (imageUrl) => {
  try {
    // Initialize OpenAI model with vision capabilities
    const model = new ChatOpenAI({
      modelName: "gpt-4o-mini",
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
