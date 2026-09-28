'use strict';

/**
 * Minimal protobuf encoder for eufy smart commands sent to devices connected via MQTT.
 *
 * The app sends a proto.cloud.ModeCtrlRequest on the command data point (152) to start a clean,
 * the JSON form used by this adapter is converted into that protobuf here. Field numbers are taken
 * from the eufy protobuf definitions (proto/cloud/control.proto).
 */

/** Eufy smart command codes (proto.cloud.ModeCtrlRequest.Method). */
const EUFY_SMART_COMMAND = {
  START_AUTO_CLEAN: 0,
  START_SELECT_ROOMS_CLEAN: 1,
  START_SELECT_ZONES_CLEAN: 2,
  START_SPOT_CLEAN: 3,
  START_GOTO_CLEAN: 4,
  START_GOHOME: 6,
  START_FAST_MAPPING: 9,
  STOP_TASK: 12,
  PAUSE_TASK: 13,
  RESUME_TASK: 14,
  START_SCENE_CLEAN: 24,
};

/** Data point used for smart commands on devices connected via MQTT. */
const MQTT_COMMAND_DPS = 152;

function encodeVarint(value) {
  const bytes = [];
  let current = value;
  while (current > 0x7f) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

/** sint32 values are zigzag encoded (proto.cloud.Point). */
function encodeZigZag(value) {
  return value < 0 ? -value * 2 - 1 : value * 2;
}

/**
 * Encode a varint field. Zero values are omitted, as proto3 encoders do.
 */
function fieldVarint(field, value) {
  if (!value) {
    return Buffer.alloc(0);
  }
  return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
}

function fieldMessage(field, body) {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(body.length), body]);
}

function point(x, y) {
  return Buffer.concat([fieldVarint(1, encodeZigZag(x)), fieldVarint(2, encodeZigZag(y))]);
}

/**
 * Build a ModeCtrlRequest protobuf (with varint length prefix) for a smart command.
 * @param {string} name Command name, e.g. selectRoomsClean or sceneClean
 * @param {Record<string, any>} data Command payload
 * @returns {Buffer | null} encoded request or null if the command is unsupported / incomplete
 */
function buildModeCtrlRequest(name, data) {
  const payload = data || {};
  const command = String(name || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const cleanTimes = Number(payload.cleanTimes) || 1;
  let method = null;
  let body = Buffer.alloc(0);

  switch (command) {
    case 'start':
    case 'autoclean':
    case 'startautoclean':
      method = EUFY_SMART_COMMAND.START_AUTO_CLEAN;
      body = fieldMessage(3, fieldVarint(1, cleanTimes));
      break;
    case 'stop':
    case 'stoptask':
      method = EUFY_SMART_COMMAND.STOP_TASK;
      break;
    case 'pause':
    case 'pausetask':
      method = EUFY_SMART_COMMAND.PAUSE_TASK;
      break;
    case 'resume':
    case 'resumetask':
      method = EUFY_SMART_COMMAND.RESUME_TASK;
      break;
    case 'gohome':
    case 'startgohome':
      method = EUFY_SMART_COMMAND.START_GOHOME;
      break;
    case 'sceneclean': {
      if (!payload.sceneId) {
        return null;
      }
      method = EUFY_SMART_COMMAND.START_SCENE_CLEAN;
      body = fieldMessage(14, fieldVarint(1, Number(payload.sceneId)));
      break;
    }
    case 'roomclean':
    case 'selectroomsclean': {
      const roomIds = (payload.roomIds || []).map(Number);
      if (!roomIds.length) {
        return null;
      }
      method = EUFY_SMART_COMMAND.START_SELECT_ROOMS_CLEAN;
      let rooms = Buffer.alloc(0);
      roomIds.forEach((id, index) => {
        rooms = Buffer.concat([rooms, fieldMessage(1, Buffer.concat([fieldVarint(1, id), fieldVarint(2, index + 1)]))]);
      });
      const roomsClean = Buffer.concat([
        rooms,
        fieldVarint(2, cleanTimes),
        fieldVarint(3, Number(payload.mapId) || 0),
        fieldVarint(5, payload.mode === 'CUSTOMIZE' ? 1 : 0),
      ]);
      body = fieldMessage(4, roomsClean);
      break;
    }
    case 'zoneclean':
    case 'selectzonesclean': {
      const zones = payload.zones || [];
      if (!zones.length) {
        return null;
      }
      method = EUFY_SMART_COMMAND.START_SELECT_ZONES_CLEAN;
      let encodedZones = Buffer.alloc(0);
      zones.forEach((zone) => {
        const quadrangle = Buffer.concat([
          fieldMessage(1, point(Number(zone.x0), Number(zone.y0))),
          fieldMessage(2, point(Number(zone.x1), Number(zone.y1))),
          fieldMessage(3, point(Number(zone.x2), Number(zone.y2))),
          fieldMessage(4, point(Number(zone.x3), Number(zone.y3))),
        ]);
        const zoneBody = Buffer.concat([
          fieldMessage(1, quadrangle),
          fieldVarint(2, Number(zone.cleanTimes) || cleanTimes),
        ]);
        encodedZones = Buffer.concat([encodedZones, fieldMessage(1, zoneBody)]);
      });
      body = fieldMessage(5, Buffer.concat([encodedZones, fieldVarint(2, Number(payload.mapId) || 0)]));
      break;
    }
    case 'spot':
    case 'spotclean':
      method = EUFY_SMART_COMMAND.START_SPOT_CLEAN;
      body = fieldMessage(6, fieldVarint(1, cleanTimes));
      break;
    case 'goto': {
      // target "spot" = clean around the given point, "destination" = drive there only
      const gotoType = payload.target === 'destination' ? 0 : 1;
      method = EUFY_SMART_COMMAND.START_GOTO_CLEAN;
      const destination = point(Number(payload.x) || 0, Number(payload.y) || 0);
      body = fieldMessage(
        7,
        Buffer.concat([
          fieldMessage(1, destination),
          fieldVarint(2, gotoType),
          fieldVarint(3, cleanTimes),
          fieldVarint(4, Number(payload.mapId) || 0),
        ]),
      );
      break;
    }
    default:
      return null;
  }

  const request = Buffer.concat([method ? fieldVarint(1, method) : Buffer.alloc(0), body]);
  return Buffer.concat([encodeVarint(request.length), request]);
}

/**
 * Build the command data point payload for remote.sendCommand. Accepts the JSON command
 * documented in the README or a raw protobuf value in hex.
 * @param {any} value State value of remote.sendCommand
 * @returns {string | null} base64 value to send on the command data point
 */
function buildSmartCommandPayload(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'string' && /^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) {
    return Buffer.from(value, 'hex').toString('base64');
  }
  const command = typeof value === 'string' ? JSON.parse(value) : value;
  const request = buildModeCtrlRequest(command.method, command.data);
  return request ? request.toString('base64') : null;
}

module.exports = {
  EUFY_SMART_COMMAND,
  MQTT_COMMAND_DPS,
  buildModeCtrlRequest,
  buildSmartCommandPayload,
};
