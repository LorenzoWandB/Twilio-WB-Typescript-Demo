import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import dotenv from 'dotenv';
import twilio from 'twilio';
import OpenAI from 'openai';
import * as weave from 'weave';

dotenv.config();

const VoiceResponse = twilio.twiml.VoiceResponse;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Weave for tracing
let weaveClient: any;
(async () => {
  weaveClient = await weave.init('Lorenzo-Team/Twilio-Voice-Assistant');
})();

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Health check endpoint for Twilio
app.get('/health', (req, res) => res.send('OK'));

// TwiML endpoint for incoming calls
app.post('/incoming-call', (req, res) => {
  const response = new VoiceResponse();
  const connect = response.connect();
  const conversationRelay = connect.conversationRelay({
    url: `wss://${req.headers.host}`,
    debug: 'debugging speaker-events tokens-played'  // Enable debug logging
  });
  
  // Add language configuration with a valid Google voice
  conversationRelay.language({
    code: 'en-US',
    ttsProvider: 'google',
    voice: 'en-US-Standard-C'  // Using a standard Google voice
  });
  
  res.type('text/xml');
  res.send(response.toString());
});

// Conversation Relay WebSocket handler
wss.on('connection', (ws) => {
  console.log('Twilio ConversationRelay connected');
  let callSid: string | null = null;

  // Helper function to send text response to Twilio for TTS
  const sendText = weave.op(function sendTextToTTS(text: string, lang = 'en-US') {
    if (!text) return;
    // You can stream tokens for lower latency; here we send the whole line.
    const payload = {
      type: 'text',
      token: text,         // ✅ required - using 'token' not 'text'
      last: true,          // ✅ mark this as the last token in this "talk turn"
      lang,                // optional; otherwise TwiML default is used
      interruptible: true, // optional
      preemptible: true    // optional
    };
    console.log('Sending to Twilio for TTS:', text);
    ws.send(JSON.stringify(payload));
  });
  
  // Helper function to get AI response
  const getAIResponse = weave.op(async function getAIResponse(userMessage: string): Promise<string> {
    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          { role: "system", content: "You are a helpful voice assistant. Keep responses concise and conversational." },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7,
        max_tokens: 150
      });
      return completion.choices[0]?.message?.content || "I'm sorry, I didn't understand that.";
    } catch (error) {
      console.error('OpenAI error:', error);
      return "I'm having trouble processing that request. Please try again.";
    }
  });

  // Main message handler
  const handleMessage = async (data: any) => {
    const msg = JSON.parse(data.toString());
    console.log('Received:', msg.type, msg);
    
    switch (msg.type) {
      case 'setup':
        // Initial setup from Twilio - this is when the call connects
        const handleSetup = weave.op(function handleCallSetup(setupMsg: any) {
          callSid = setupMsg.callSid;
          console.log('Call SID:', callSid);
          console.log('From:', setupMsg.from);
          console.log('To:', setupMsg.to);
          
          // Send initial greeting after setup
          sendText('Hello! Welcome to the voice assistant. How can I help you today?');
          
          return {
            callSid: setupMsg.callSid,
            from: setupMsg.from,
            to: setupMsg.to,
            timestamp: new Date().toISOString()
          };
        });
        handleSetup(msg);
        break;

      case 'prompt':
        // User spoke something - msg.voicePrompt contains the transcribed text
        const handlePrompt = weave.op(async function handleConversationTurn(promptMsg: any) {
          if (promptMsg.voicePrompt) {
            const userMessage = promptMsg.voicePrompt;
            console.log('User said:', userMessage);
            console.log('Language:', promptMsg.lang);
            
            const startTime = Date.now();
            
            // Get AI response from OpenAI
            const aiResponse = await getAIResponse(userMessage);
            console.log('AI response:', aiResponse);
            
            const processingTime = Date.now() - startTime;
            
            sendText(aiResponse);
            
            return {
              userMessage,
              aiResponse,
              language: promptMsg.lang,
              processingTimeMs: processingTime,
              timestamp: new Date().toISOString()
            };
          }
        });
        await handlePrompt(msg);
        break;

      case 'interrupt':
        // User interrupted the assistant while it was speaking
        const handleInterrupt = weave.op(function handleUserInterruption(interruptMsg: any) {
          console.log('User interrupted');
          console.log('Utterance until interrupt:', interruptMsg.utteranceUntilInterrupt);
          console.log('Duration until interrupt (ms):', interruptMsg.durationUntilInterruptMs);
          
          return {
            utteranceUntilInterrupt: interruptMsg.utteranceUntilInterrupt,
            durationUntilInterruptMs: interruptMsg.durationUntilInterruptMs,
            timestamp: new Date().toISOString()
          };
        });
        handleInterrupt(msg);
        break;

      case 'dtmf':
        // User pressed a phone key
        const handleDTMF = weave.op(function handleDTMFInput(dtmfMsg: any) {
          console.log('DTMF digit received:', dtmfMsg.digit);
          sendText(`You pressed ${dtmfMsg.digit}`);
          
          return {
            digit: dtmfMsg.digit,
            timestamp: new Date().toISOString()
          };
        });
        handleDTMF(msg);
        break;

      case 'error':
        // Error from Twilio
        console.error('Error from Twilio:', msg.description || msg.message || msg);
        break;

      case 'stop':
        // Call ended
        const handleStop = weave.op(function handleCallEnd(stopMsg: any) {
          console.log('Call ended');
          
          return {
            callSid,
            reason: stopMsg.reason || 'normal',
            timestamp: new Date().toISOString()
          };
        });
        handleStop(msg);
        break;
    }
  };
  
  ws.on('message', handleMessage);

  ws.on('close', (code, reason) => {
    console.log('Twilio ConversationRelay disconnected',
                code, reason?.toString?.() || '');
  });
  ws.on('error', (error) => console.error('WebSocket error:', error));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log('\nTo connect with Twilio:');
  console.log('1. Run: ngrok http 3000');
  console.log('2. Use the ngrok URL in your Twilio Voice webhook');
});