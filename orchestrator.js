/*
 * orchestrator.js
 *
 * This service acts as the control plane between the WhatsApp Calling
 * Cloud API (via 360dialog or Meta's Cloud API) and your media edge.  It
 * receives webhook events from WhatsApp (e.g. `connect` and
 * `terminate`), forwards the SDP offer to an edge component capable of
 * handling WebRTC media, and then performs the required API calls
 * (`pre_accept` and `accept`) so that media can flow.  When the call
 * ends, it instructs the edge to tear down the session.
 *
 * The business logic of your VoiceBot lives behind Twilio and is not
 * part of this orchestrator.  Twilio will expose your Voice URL via
 * the SIP Interface (see README.md for details), and will open a
 * WebSocket for media (`<Connect><Stream>` in your TwiML).  Your
 * existing Twilio handler can continue to run unchanged.
 *
 * Usage:
 *   node orchestrator.js
 *
 * Environment variables:
 *   WABA_TOKEN      – Bearer token for the WhatsApp Business Account
 *   WABA_BASE       – Base URL for the Cloud API (default: v20.0)
 *   WABA_PHONE_ID   – phone_number_id obtained from your WABA
 *   EDGE_API        – URL of the media edge (e.g. https://edge.example.com)
 *   PORT            – port for this HTTP server (default: 3000)
 */

const express = require('express');
const axios = require('axios');
const pino = require('pino');

const app = express();
app.use(express.json({ limit: '2mb' }));

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// Required environment variables
const {
  WABA_TOKEN,
  WABA_BASE = 'https://graph.facebook.com/v20.0',
  WABA_PHONE_ID,
  EDGE_API,
  PORT = 3000,
} = process.env;

if (!WABA_TOKEN || !WABA_PHONE_ID || !EDGE_API) {
  log.fatal(
    'WABA_TOKEN, WABA_PHONE_ID and EDGE_API environment variables must be set.'
  );
  process.exit(1);
}

/*
 * Helper: perform a POST against the Cloud API.  The WhatsApp Business
 * Account token is added to the Authorization header.
 */
async function callWaba(path, payload) {
  const url = `${WABA_BASE}/${WABA_PHONE_ID}${path}`;
  log.debug({ url, payload }, 'Calling WABA API');
  return axios.post(url, payload, {
    headers: { Authorization: `Bearer ${WABA_TOKEN}` },
  });
}

/**
 * Pre-accept the call using your SDP answer.  This step prevents
 * clipping at the beginning of the call by letting WhatsApp know
 * immediately what media parameters you support.
 *
 * @param {string} callId  – call_id from the webhook
 * @param {string} sdpAnswer – SDP answer returned from the edge
 */
async function preAccept(callId, sdpAnswer) {
  await callWaba(`/calls/${callId}/pre_accept`, {
    sdp: sdpAnswer,
    sdp_type: 'answer',
  });
}

/**
 * Accept the call.  After this call returns, media will begin
 * flowing between the caller and your edge.
 *
 * @param {string} callId – call_id from the webhook
 */
async function accept(callId) {
  await callWaba(`/calls/${callId}/accept`, {});
}

/**
 * Terminate the call on WhatsApp.  Not strictly necessary, since
 * WhatsApp will clean up when your edge ends the session, but
 * sending a terminate request ensures resources are released.
 *
 * @param {string} callId – call_id from the webhook
 */
async function terminate(callId) {
  try {
    await callWaba(`/calls/${callId}/terminate`, {});
  } catch (err) {
    log.warn({ err }, 'Failed to call terminate');
  }
}

// Maintain a simple in-memory mapping of WA call_id → edgeSessionId
const activeCalls = new Map();

/*
 * Webhook for incoming call events.  When WhatsApp sends a
 * `connect` event, the body looks like:
 * {
 *   call_id: 'string',
 *   session: { sdp: '...', sdp_type: 'offer' },
 *   direction: 'inbound',
 *   ...
 * }
 */
app.post('/wa/calling/connect', async (req, res) => {
  const { call_id: callId, session } = req.body;
  if (!callId || !session || !session.sdp) {
    res.status(400).send('Invalid payload');
    return;
  }
  log.info({ callId }, 'Received connect webhook');
  try {
    // Forward SDP offer to the media edge.  The edge is expected to
    // allocate a PeerConnection, generate an SDP answer and start
    // negotiating with WhatsApp.  It returns both the edge session
    // identifier and the SDP answer.
    const resp = await axios.post(`${EDGE_API}/webrtc/new`, {
      call_id: callId,
      sdp_offer: session.sdp,
    });
    const { edge_session_id: edgeSessionId, sdp_answer: sdpAnswer } = resp.data;
    if (!edgeSessionId || !sdpAnswer) {
      throw new Error('Edge did not return session_id or sdp_answer');
    }
    // Record mapping
    activeCalls.set(callId, { edgeSessionId });
    // Pre-accept and accept to start media
    await preAccept(callId, sdpAnswer);
    await accept(callId);
    res.sendStatus(200);
  } catch (err) {
    log.error({ err }, 'Error handling connect');
    res.sendStatus(500);
  }
});

/*
 * Webhook for call termination events.  WhatsApp will call this when
 * the caller hangs up.  We instruct the edge to tear down its
 * PeerConnection and free any resources.
 */
app.post('/wa/calling/terminate', async (req, res) => {
  const { call_id: callId } = req.body;
  log.info({ callId }, 'Received terminate webhook');
  try {
    const state = activeCalls.get(callId);
    if (state && state.edgeSessionId) {
      // Ask edge to hang up
      await axios.post(`${EDGE_API}/webrtc/hangup`, {
        edge_session_id: state.edgeSessionId,
      });
      activeCalls.delete(callId);
    }
    // Notify WhatsApp just in case
    await terminate(callId);
    res.sendStatus(200);
  } catch (err) {
    log.error({ err }, 'Error handling terminate');
    res.sendStatus(500);
  }
});

// Default route to verify server health
app.get('/', (req, res) => {
  res.send('WhatsApp → Twilio Gateway orchestrator is running');
});

app.listen(PORT, () => {
  log.info(`Orchestrator listening on port ${PORT}`);
});