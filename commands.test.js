'use strict';

/**
 * Tests for the smart command encoder (lib/eufyCommands.js).
 *
 * The expected values are the byte sequences the eufy app / device itself uses
 * (verified against the eufy protobuf definitions and against data points reported by a T2292).
 */

const { expect } = require('chai');
const { MQTT_COMMAND_DPS, buildModeCtrlRequest, buildSmartCommandPayload } = require('./lib/eufyCommands');

/**
 * Commands as documented in the README, with the expected protobuf as hex.
 * @type {Array<[string, { method: string, data: Record<string, any> }, string]>}
 */
const vectors = [
  ['start', { method: 'start', data: { cleanTimes: 1 } }, '041a020801'],
  ['start twice', { method: 'start', data: { cleanTimes: 2 } }, '041a020802'],
  ['pause', { method: 'pause', data: {} }, '02080d'],
  ['resume', { method: 'resume', data: {} }, '02080e'],
  ['stop', { method: 'stop', data: {} }, '02080c'],
  ['goHome', { method: 'goHome', data: {} }, '020806'],
  ['sceneClean Keller', { method: 'sceneClean', data: { sceneId: 1790101212 } }, '0a0818720608dc8dcbd506'],
  [
    'sceneClean Erdgeschoss',
    { method: 'sceneClean', data: { sceneId: 1790101256 } },
    '0a0818720608888ecbd506',
  ],
  [
    'sceneClean Obergeschoss',
    { method: 'sceneClean', data: { sceneId: 1790101297 } },
    '0a0818720608b18ecbd506',
  ],
  [
    'selectRoomsClean 3 rooms',
    { method: 'selectRoomsClean', data: { roomIds: [11, 12, 13], mapId: 1, cleanTimes: 1 } },
    '1a080122160a04080b10010a04080c10020a04080d100310011801',
  ],
  [
    'selectRoomsClean single room twice',
    { method: 'selectRoomsClean', data: { roomIds: [5], mapId: 2, cleanTimes: 2 } },
    '0e0801220a0a040805100110021802',
  ],
  [
    'selectZonesClean',
    {
      method: 'selectZonesClean',
      data: {
        mapId: 1,
        zones: [{ x0: -1130, y0: 646, x1: -830, y1: 646, x2: -830, y2: 346, x3: -1130, y3: 346, cleanTimes: 1 }],
      },
    },
    '2c08022a280a240a200a0608d311108c0a120608fb0c108c0a1a0608fb0c10b405220608d31110b40510011001',
  ],
  ['spotClean', { method: 'spotClean', data: { cleanTimes: 1 } }, '06080332020801'],
  ['goto spot', { method: 'goto', data: { x: -179, y: 36, target: 'spot', cleanTimes: 1 } }, '0f08043a0b0a0508e502104810011801'],
  [
    'goto destination',
    { method: 'goto', data: { x: -179, y: 36, target: 'destination', cleanTimes: 1 } },
    '0d08043a090a0508e50210481801',
  ],
];

describe('eufy smart commands', () => {
  it('uses the MQTT command data point', () => {
    expect(MQTT_COMMAND_DPS).to.equal(152);
  });

  for (const [name, command, expected] of vectors) {
    it(`encodes ${name}`, () => {
      const request = buildModeCtrlRequest(command.method, command.data);
      expect(request, `no request for ${name}`).to.not.equal(null);
      expect(/** @type {Buffer} */ (request).toString('hex')).to.equal(expected);
    });

    it(`sends ${name} as base64 on remote.sendCommand`, () => {
      const payload = buildSmartCommandPayload(JSON.stringify(command));
      expect(payload).to.equal(Buffer.from(expected, 'hex').toString('base64'));
    });
  }

  it('accepts a raw protobuf value in hex', () => {
    expect(buildSmartCommandPayload('0a0818720608dc8dcbd506')).to.equal(
      Buffer.from('0a0818720608dc8dcbd506', 'hex').toString('base64'),
    );
  });

  it('rejects incomplete commands', () => {
    expect(buildSmartCommandPayload('{"method":"sceneClean","data":{}}')).to.equal(null);
    expect(buildSmartCommandPayload('{"method":"selectRoomsClean","data":{}}')).to.equal(null);
    expect(buildSmartCommandPayload('{"method":"nope","data":{}}')).to.equal(null);
  });

  it('rejects empty values', () => {
    expect(buildSmartCommandPayload('')).to.equal(null);
    expect(buildSmartCommandPayload(null)).to.equal(null);
  });

  it('throws on invalid JSON so the adapter can log it', () => {
    expect(() => buildSmartCommandPayload('not json')).to.throw();
  });
});
