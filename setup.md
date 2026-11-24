I'll build this as a Gemini-powered Chrome extension, bundle it with docs, samples and an evaluation script, and send you the zip.

I've built the project and packed it into **ThreadLens-PS78.zip**, ready to send to your brother. It's a Chrome extension that opens in a side panel and uses Gemini.

I couldn't run it with a real Gemini key here. I tested everything with simulated Gemini replies: the extension loads in Chrome with no errors, the full flow works, and the 16 built-in tests pass. So the first real check is the step below.

**What he needs to do:**

1. Open `.env` and add a free key from aistudio.google.com: `GEMINI_API_KEY=...`
2. Run `node setup.js` (or `python setup.py`).
3. Go to `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `extension` folder.
4. Open a Gmail thread, click the ThreadLens icon, then **Grab thread** and **Analyse**. If he doesn't want to use Gmail, there are three sample threads built in.

If he can't run the setup script, he can paste the key into the ⚙️ Settings instead.

**How it covers each step of the problem statement:**

- **Long email thread:** grabs the thread straight from Gmail, or he can paste one. The three samples include a 26-email thread.
- **Summary and action items with owners:** a short summary, key points, decisions and open questions. Each action item has an owner, deadline, status, priority and the exact quote it came from. Every point is tagged with the email it came from; clicking the tag opens that email with the sentence highlighted.
- **Checking faithfulness:** first, code checks that each quote really appears in its email and that the owner and deadline are in the thread. Then a second Gemini call fact-checks each point. Every point gets a ✅/⚠️/❌ badge, plus an overall score.
- **Long threads:** quoted replies are removed first (about 75% of the text on the samples). Anything still too long is split between emails, processed in parallel and merged, with later emails winning.
- **Privacy:** emails, phone numbers, ID numbers and passwords or keys are hidden on his computer before anything is sent to Gemini. Names can be hidden too, with a toggle.
- **Presenting results:** a clean side panel (light and dark mode), the chatbot for follow-up questions with sources, and export to Markdown, CSV or JSON.

The zip also has a README with short answers to both jury questions, and a full project report. That has the longer answers, privacy limits, a 3-minute demo script and 10 likely jury questions. There's also an evaluation script (`npm run eval`): once his key is in, it measures accuracy and checks whether the tool catches false action items planted on purpose. He should put that results table in his slides.

The default model is `gemini-3.8-flash`. If his key gives a "model not found" error, he can switch the model in `.env` or in Settings. He also shouldn't share the zip again after putting his real key in it.
