# WebRTC to SIP (WhatsApp Calls to Twilio Gateway)

This repository contains an **orchestrator** service and supporting
instructions to help you bridge inbound WhatsApp Calling sessions
through to Twilio where your existing VoiceBot logic (written in
TwiML) can take over.  The orchestrator is designed to run on a
platform such as Railway, while the media handling requires an
external host with UDP support (see below).

## Overview

When a customer taps the call button in your WhatsApp Business chat,
Meta/WhatsApp will send a webhook to the endpoint you configured in
WhatsApp Manager (via 360dialog or the Meta Cloud API).  The
orchestrator performs the following steps:

1. **Receive the `connect` webhook** with a WebRTC SDP offer.
2. **Forward the offer to your media edge** (a service capable of
   handling DTLS-SRTP and WebRTC) via `POST /webrtc/new`.  The edge
   returns an SDP answer and a unique session identifier.
3. **Pre-accept and accept the call** using the WhatsApp Business
   Calling API (`/pre_accept` and `/accept`), passing along the SDP
   answer.  This ensures that media begins flowing immediately.
4. **Record the mapping** of call ID to edge session ID so that
   subsequent webhooks (e.g. `terminate`) can clean up resources.
5. When WhatsApp sends a `terminate` event, **instruct the edge to
   tear down** the WebRTC PeerConnection via `POST /webrtc/hangup` and
   optionally send a final `/terminate` to WhatsApp.

Media never flows through the orchestrator; it is purely a control
plane component.  Audio is bridged separately between the caller and
Twilio by your media edge (see below).

## Why you need a media edge

Railway and similar serverless platforms do not support inbound UDP
traffic.  WhatsApp Calling uses WebRTC, which relies on UDP for the
media channel.  Likewise, Twilio's SIP Interface requires RTP/UDP for
media.  To bridge the two, you need a host with a static IP that can
listen on UDP ports.  A common pattern is to deploy a media server
such as **FreeSWITCH**, **webrtc2sip**, or a custom Go application
using Pion.  The edge negotiates the WebRTC session with WhatsApp and
then originates a SIP call to Twilio.  Twilio, in turn, invokes your
existing TwiML (which likely includes `<Connect><Stream>` to your
VoiceBot).

In short:

```
WhatsApp (WebRTC/Opus) ↔ Media Edge (UDP) ↔ Twilio SIP Interface ↔ TwiML ↔ VoiceBot
```

Because of the UDP requirement, **the media edge cannot run on
Railway**.  You should provision a small VPS (e.g. DigitalOcean,
Vultr, Hetzner) with a public IP for this purpose.  See the
`Edge Setup` section below for a high‑level guide.

## Orchestrator deployment

The orchestrator runs comfortably on Railway since it only needs to
handle HTTP requests.  To deploy:

1. Create a new Node.js service in Railway and connect this
   repository.
2. Set the following environment variables in Railway:

   - `WABA_TOKEN`: Your WhatsApp Business Account bearer token.
   - `WABA_PHONE_ID`: Your WhatsApp phone number ID.
   - `EDGE_API`: The base URL of your media edge (for example
     `https://edge.example.com:8080`).
   - `WABA_BASE` *(optional)*: Base URL for the Cloud API (default
     `https://graph.facebook.com/v20.0`).  If you are using 360dialog
     you may need to customise this.

3. Set your webhook URL in WhatsApp Manager/360dialog to point to
   `https://<your-railway-host>/wa/calling/connect` for connect events and
   `https://<your-railway-host>/wa/calling/terminate` for terminate
   events.
4. Install dependencies and start the server:

   ```bash
   npm install
   npm start
   ```

The orchestrator exposes `GET /` for health checks.

## Edge setup (high level)

To handle WebRTC and bridge audio to Twilio, you can use any media
server that supports both protocols.  One tested option is
[webrtc2sip](https://github.com/DoubangoTelecom/webrtc2sip), an open
source gateway.  Another is [FreeSWITCH](https://freeswitch.com/),
which can act as a B2BUA and supports WebRTC, SIP and media
transcoding.

Below is a simplified outline using FreeSWITCH:

1. Provision a small VPS with a public IP.  Open UDP ports
   10000–60000 and TCP ports 5060, 5061 and 7443.  Inbound UDP is
   mandatory (Railway does not support inbound UDP【320851522387900†L50-L54】).
2. Install FreeSWITCH and enable the **internal** profile for WebRTC
   (listening on port 7443 for DTLS‑SRTP) and the **external** profile
   for SIP (port 5060).  Load the `mod_verto` and `mod_opus` modules.
3. Create a SIP gateway pointing to Twilio SIP Interface with your
   Twilio credentials.  A basic gateway configuration is included
   below (replace variables as needed):

   ```xml
   <gateway name="twilio-sip">
     <param name="proxy" value="sip:us1.sip.twilio.com"/>
     <param name="register" value="false"/>
     <param name="realm" value="us1.sip.twilio.com"/>
     <param name="username" value="${TWILIO_SIP_USER}"/>
     <param name="password" value="${TWILIO_SIP_PASS}"/>
     <param name="caller-id-in-from" value="true"/>
     <variables>
       <variable name="sip_h_X-Twilio-Account" value="${TWILIO_ACCOUNT_SID}"/>
     </variables>
   </gateway>
   ```

4. Add a dialplan entry that bridges the WebRTC caller to Twilio via
   the gateway.  For example:

   ```xml
   <extension name="wa-to-twilio">
     <condition field="destination_number" expression="^from-wa$">
       <action application="set" data="absolute_codec_string=OPUS,PCMU"/>
       <action application="bridge" data="sofia/gateway/twilio-sip/sip:wa-gateway.sip.twilio.com"/>
     </condition>
   </extension>
   ```

5. Expose a simple API (HTTP or ESL) on the edge to
   
   - create a new WebRTC session when the orchestrator calls
     `POST /webrtc/new`, returning a unique session ID and the SDP
     answer, and bridging to Twilio via the dialplan above; and
   - tear down the session on `POST /webrtc/hangup`.

The details of implementing this API depend on your chosen media
server.  For FreeSWITCH you can script this using its Event Socket
Layer (ESL) or mod_verto; for webrtc2sip you can use its built-in
HTTP API.

## Alternatives

If you are comfortable writing code, you can implement the media edge
yourself using [Pion](https://github.com/pion/webrtc) (Go) or
[node-webrtc](https://github.com/node-webrtc/node-webrtc) together
with a SIP library such as [drachtio-srf](https://github.com/drachtio/drachtio-srf).
These libraries give you full control over SDP negotiation and media
flow, but require significantly more work to handle DTLS, ICE,
transcoding (Opus↔PCMU) and SIP signalling.

## Caveats

* **Incoming UDP is not supported on Railway**【320851522387900†L50-L54】;
  therefore, the media edge must run on a different host with a
  static IP.
* WhatsApp Calling is currently in beta and subject to change.  Only
  accounts that meet Meta's eligibility requirements may enable
  calling.
* This repository does **not** include the full media edge
  implementation.  You must deploy or build a compatible gateway
  (e.g. FreeSWITCH, webrtc2sip, or a custom solution) on a host with
  UDP support.

## License

MIT.  See [LICENSE](../LICENSE) for details.
