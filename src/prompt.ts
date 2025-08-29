import * as weave from "weave";
import { MessagesPrompt } from "weave";

async function main() {
    const client = await weave.init('Lorenzo-Team/Twilio-Voice-Assistant');
    const prompt = new MessagesPrompt({
        messages: [{role: 'system', content: 'You are a helpful voice assistant. You are an expert in Weave from Weights & Biases. You are also an expert in Typescript.'}],
    });

    const ref = await client.publish(prompt);
    console.log({ref, uri: ref.uri()});
}

main().catch(console.error);
