'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.3
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');

const myDeviceTypes = require('./lib/devices');
const myHelper = require('./lib/helper');

// Load your modules here, e.g.:
// const fs = require("fs");

class UnifiProtectNvr extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'unifi-protect-nvr',
		});

		this.isConnected = false;
		this.ufp = undefined;
		this.devices = {
			cameras: {}
		};

		this.eventStore = {
			cameras: {}
		};

		this.aliveInterval = 15;
		this.aliveTimeout = null;
		this.aliveTimestamp = new Date().getTime();

		this.connectionMaxRetries = 200;
		this.connectionRetries = 0;

		this.paths = {
			eventThumb: '/proxy/protect/api/events/{0}/thumbnail',
		};

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		const logPrefix = '[onReady]:';

		try {
			if (this.config.host, this.config.user, this.config.password) {
				this.log.debug(`${logPrefix} Loading unifi-protect ESM Module dynamically`);

				const UnifiProtectImport = (await import('unifi-protect')).ProtectApi;
				this.ufp = new UnifiProtectImport(this.log);

				// listen to realtime events (must be given as function to be able to use this)
				this.ufp.on('message', (event) => this.onProtectEvent(event));

				await this.establishConnection(true);

			} else {
				this.log.warn(`${logPrefix} no login credentials in adapter config set!`);
			}

		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		const logPrefix = '[onUnload]:';
		try {
			// Here you must clear all timeouts or intervals that may still be active
			if (this.aliveTimeout) clearTimeout(this.aliveTimeout);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);
			if (this.ufp) {
				this.ufp.reset();
				this.setConnectionStatus(false);
				this.log.info(`${logPrefix} Logged out successfully from the Unifi-Protect controller API. (host: ${this.config.host})`);
			}

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		const logPrefix = '[onStateChange]:';
		try {
			if (this.isConnected && this.ufp) {

				if (state && !state.from.includes(this.namespace)) {
					// The state was changed
					if (id.includes('cameras')) {
						const camId = id.split('.')[3];

						if (this.devices.cameras[camId]) {
							const objWrite = myHelper.strToObj(id.split(`${camId}.`).pop(), state.val);
							this.ufp.updateDevice(this.devices.cameras[camId], objWrite);

							this.log.info(`${logPrefix} cam state '${id}' changed to '${state.val}'`);
						} else {
							this.log.error(`${logPrefix} cam (id ${camId}) not exists in devices list`);
						}
					} else {
						this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
					}
				} else {
					// The state was deleted
					// this.log.info(`state ${id} deleted`);
				}
			} else {
				this.log.warn(`${logPrefix} No Connection to the Unifi-Controller, '${id}' cannot be written!`);
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }

	async establishConnection(isAdapterStart = false) {
		const logPrefix = '[establishConnection]:';

		try {
			if (await this.login()) {
				await this.getDevices(isAdapterStart);
			}

			// start the alive checker
			if (this.aliveTimeout) {
				this.clearTimeout(this.aliveTimeout);
				this.aliveTimeout = null;
			}

			this.aliveTimeout = this.setTimeout(() => {
				this.aliveChecker();
			}, this.aliveInterval * 1000);

		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	async login() {
		const logPrefix = '[login]:';

		try {
			if (this.ufp) {
				const loginSuccessful = await this.ufp.login(this.config.host, this.config.user, this.config.password);

				if (loginSuccessful) {
					this.log.info(`${logPrefix} Logged in successfully to the Unifi-Protect controller API. (host: ${this.config.host})`);

					if (await this.ufp.getBootstrap()) {
						this.log.debug(`${logPrefix} successfully received bootstrap`);
						await this.setConnectionStatus(true);

						return true;
					} else {
						this.log.error(`${logPrefix} Unable to bootstrap the Unifi-Protect controller API`);
					}
				} else {
					this.log.error(`${logPrefix} Login to the Unifi-Protect controller API failed! (host: ${this.config.host})`);
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}

		await this.setConnectionStatus(false);

		return false;
	}

	async getDevices(isAdapterStart) {
		const logPrefix = '[getDevices]:';

		try {
			if (this.ufp && this.ufp.bootstrap) {
				// this.log.warn(JSON.stringify(this.ufp.bootstrap));


				// Add Cameras to List
				if (this.ufp.bootstrap.cameras) {
					for (const cam of this.ufp.bootstrap.cameras) {
						this.log.info(`${logPrefix}: Discovered ${cam.modelKey}: ${this.ufp.getDeviceName(cam, cam.name)} (IP: ${cam.host}, mac: ${cam.mac}, id: ${cam.id}, state: ${cam.state})`);
						this.devices.cameras[cam.id] = cam;

						if (isAdapterStart) {
							await this.createCameraStates(cam);
						}
					}
					this.log.silly(`${logPrefix} devices.cameras: ${JSON.stringify(this.devices.cameras)}`);
				}
			}

		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	/**
	 @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectEventPacket} event
	 */
	async onProtectEvent(event) {
		const logPrefix = '[onProtectEvent]:';

		try {
			this.aliveTimestamp = new Date().getTime();

			if (event.header.modelKey === 'camera') {
				const camId = event.header.id;

				await this.updateStates(camId, 'cameras', myDeviceTypes.cameras, event.payload);
			} else if (event.header.modelKey === 'event') {
				if (event.header.recordModel === 'camera') {
					const cam = this.devices.cameras[event.header.recordId];
					this.onCamMotionEvent(cam, event.header, event.payload);
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	/**
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectKnownDeviceTypes} cam
	 * @param {{ action?: string; id: any; modelKey?: string; newUpdateId?: string; mac?: string | undefined; nvrMac?: string | undefined; recordModel?: string | undefined; recordId?: string | undefined; }} header
	 * @param {object} payload
	 */
	async onCamMotionEvent(cam, header, payload) {
		const logPrefix = '[onMotionEvent]:';

		try {
			// motion events consist multiple events
			if (this.ufp) {
				// ToDo: log level silly
				this.log.warn(`${this.ufp.getDeviceName(cam)} - eventId: ${header.id}, payload: ${JSON.stringify(payload)}`);

				if (payload.type === 'motion' || payload.type === 'smartDetectZone' || payload.type === 'smartDetectLine' || this.eventStore.cameras[header.id]) {
					const camId = `cameras.${cam.id}`;

					if (Object.prototype.hasOwnProperty.call(payload, 'start')) {
						// Motion event start -> start property is available

						this.log.debug(`${logPrefix} ${this.ufp.getDeviceName(cam)} - motion event start (type: ${payload.type})`);

						this.eventStore.cameras[header.id] = {
							eventId: header.id,
							type: payload.type,
							score: payload.score ? payload.score : 0,
							start: payload.start,
							snapshotTaken: false,
						};

						// set custom types
						this.setStateExists(`${camId}.${myDeviceTypes.cameras.lastMotionType.id}`, payload.type);
						this.setStateExists(`${camId}.${myDeviceTypes.cameras.lastMotionStart.id}`, payload.start);
						this.setStateExists(`${camId}.${myDeviceTypes.cameras.lastMotionEnd.id}`, null);

						// reset snapshot & thumbnail at beginning of motion event
						if (this.config.motionSnapshot)
							this.setStateExists(`${camId}.${myDeviceTypes.cameras.lastMotionSnapshot.id}`, '');

						if (this.config.motionThumb)
							this.setStateExists(`${camId}.${myDeviceTypes.cameras.lastMotionThumbnail.id}`, '');

						if (this.config.motionSnapshot && this.config.motionSnapshotDelay >= 0 && !this.eventStore.cameras[header.id].snapshotTaken) {
							// Snapshot Delay configured
							setTimeout(() => {
								this.getSnapshot(cam, `${camId}.${myDeviceTypes.cameras.lastMotionSnapshot.id}`, this.config.motionSnapshotWidth, this.config.motionSnapshotHeight, header.id);
								this.eventStore.cameras[header.id].snapshotTaken = true;
							}, this.config.motionSnapshotDelay * 1000);
						}
					} else {
						if (this.eventStore.cameras[header.id]) {
							this.eventStore.cameras[header.id].score = payload.score ? payload.score : this.eventStore.cameras[header.id].score;
							this.eventStore.cameras[header.id].end = payload?.end;

							if (this.config.motionSnapshot && this.config.motionSnapshotDelay === -1 && !this.eventStore.cameras[header.id].snapshotTaken) {
								// Snapshot configured -1 = auto
								this.getSnapshot(cam, `${camId}.${myDeviceTypes.cameras.lastMotionSnapshot.id}`, this.config.motionSnapshotWidth, this.config.motionSnapshotHeight, header.id);
								this.eventStore.cameras[header.id].snapshotTaken = true;
							}

							if (Object.prototype.hasOwnProperty.call(payload, 'metadata') && Object.prototype.hasOwnProperty.call(payload['metadata'], 'detectedThumbnails')) {
								// Motion event finished -> paylod have 'metadata.detectedThumbnails'
								this.log.debug(`${logPrefix} ${this.ufp.getDeviceName(cam)} - motion event finished (eventStore: ${JSON.stringify(this.eventStore.cameras[header.id])})`);

								// set custom types
								this.setStateExists(`${camId}.${myDeviceTypes.cameras.lastMotionEnd.id}`, this.eventStore.cameras[header.id].end);

								if (this.config.motionThumb)
									this.getEventThumb(`${camId}.${myDeviceTypes.cameras.lastMotionThumbnail.id}`, header.id, this.config.motionThumbWidth, this.config.motionThumbHeight);

								delete this.eventStore.cameras[header.id];
							}
						}
					}
				} else if (Object.prototype.hasOwnProperty.call(payload, 'type')) {
					this.log.warn(`${logPrefix} event from type '${payload.type}' is not implemented! Please report this to the developer (header: ${JSON.stringify(header)}, payload: ${JSON.stringify(payload)})`);
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	async getEventThumb(targetId, eventId, width, height) {
		const logPrefix = '[getEventThumb]:';

		try {
			if (this.ufp && this.isConnected) {
				const url = `https://${this.config.host}${this.paths.eventThumb.replace('{0}', eventId)}?w=${width}&h=${height}`;
				const response = await this.ufp.retrieve(url, undefined, true);

				// response is from type Fetch (https://github.com/hjdhjd/unifi-protect/blob/main/docs/ProtectApi.md#retrieve)
				if (response) {
					if (response.ok) {
						const imageBuffer = Buffer.from(await response.arrayBuffer());
						const imageBase64 = imageBuffer.toString('base64');
						const base64ImgString = `data:image/jpeg;base64,` + imageBase64;

						this.log.debug(`${logPrefix} thumb successfully received (eventId: ${eventId})`);

						await this.setStateExists(targetId, base64ImgString);
					} else {
						this.log.error(`${logPrefix} response code: ${response.status}`);
					}
				} else {
					this.log.warn(`${logPrefix} no response from the server, no thumb found!`);
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	async getSnapshot(cam, targetId, width, height, eventId) {
		const logPrefix = '[getSnapshot]:';

		try {
			const imageBuffer = await this.ufp?.getSnapshot(cam, width, height);

			if (imageBuffer) {
				const imageBase64 = imageBuffer.toString('base64');
				const base64ImgString = `data:image/jpeg;base64,` + imageBase64;

				this.log.debug(`${logPrefix} snapshot successfully received (eventId: ${eventId})`);

				await this.setStateExists(targetId, base64ImgString);
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}



	/**
	 * Check whether the connection to the controller exists, if not try to establish a new connection
	 */
	async aliveChecker() {
		const logPrefix = '[aliveChecker]:';

		try {
			if (this.ufp) {
				const diff = Math.round((new Date().getTime() - this.aliveTimestamp) / 1000);

				if (diff >= this.aliveInterval) {
					this.log.warn(`${logPrefix} No connection to the Unifi-Protect controller -> restart connection (retries: ${this.connectionRetries})`);
					this.ufp.reset();

					await this.setConnectionStatus(false);

					if (this.connectionRetries < this.connectionMaxRetries) {
						this.connectionRetries++;

						await this.establishConnection();
					} else {
						this.log.error(`${logPrefix} Connection to the Unifi-Protect controller is down for more then ${this.connectionMaxRetries * this.aliveInterval}s, stopping the adapter.`);
						this.stop();
					}
				} else {
					this.log.silly(`${logPrefix} Connection to the Unifi-Protect controller is alive (last alive signal is ${diff}s old)`);

					await this.setConnectionStatus(true);
					this.connectionRetries = 0;

					if (this.aliveTimeout) {
						this.clearTimeout(this.aliveTimeout);
						this.aliveTimeout = null;
					}

					this.aliveTimeout = this.setTimeout(() => {
						this.aliveChecker();
					}, this.aliveInterval * 1000);
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	/** Create camera states
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectCameraConfigInterface} cam
	 */
	async createCameraStates(cam) {
		const logPrefix = '[createCameraStates]:';

		try {
			if (this.ufp) {
				if (!await this.objectExists(`cameras.${cam.id}`)) {
					// create cam channel
					this.log.debug(`${logPrefix} creating channel '${cam.id}' for camera '${this.ufp.getDeviceName(cam, cam.name)}'`);
					await this.createChannelAsync('cameras', cam.id, {
						name: this.ufp.getDeviceName(cam, cam.name)
					});
				}

				await this.createGenericState('cameras', cam.id, myDeviceTypes.cameras, cam);
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	/** Create all states for a devices, that are defined in {@link myDeviceTypes}
	 * @param {string} parent id of device (e.g. cameras)
	 * @param {string} channel id of channel (e.g. camera id)
	 * @param {object} deviceTypes defined states and types in {@link myDeviceTypes}
	 * @param {object} objValues ufp bootstrap values of device
	 */
	async createGenericState(parent, channel, deviceTypes, objValues) {
		const logPrefix = '[createGenericState]:';

		try {
			// {@link myDevices}
			for (const id in deviceTypes) {
				if (id && Object.prototype.hasOwnProperty.call(deviceTypes[id], 'type')) {
					// if we have a 'type' property, then it's a state

					if (!await this.objectExists(`${parent}.${channel}.${id}`)) {
						this.log.debug(`${logPrefix} creating state '${parent}.${channel}.${id}'`);
						const obj = {
							type: 'state',
							common: {
								name: deviceTypes[id].name ? deviceTypes[id].name : id,
								type: deviceTypes[id].type,
								read: true,
								write: deviceTypes[id].write ? deviceTypes[id].write : false,
								role: deviceTypes[id].role ? deviceTypes[id].role : 'state',
								unit: deviceTypes[id].unit ? deviceTypes[id].unit : '',
							},
							native: {}
						};

						if (deviceTypes[id].states) {
							obj.common.states = deviceTypes[id].states;
						}

						await this.setObjectAsync(`${parent}.${channel}.${id}`, obj);
					}

					if (deviceTypes[id].write && deviceTypes[id].write === true) {
						// state is writeable -> subscribe it
						this.log.silly(`${logPrefix} subscribing state '${parent}.${channel}.${id}'`);
						await this.subscribeStatesAsync(`${parent}.${channel}.${id}`);
					}

					if (objValues && Object.prototype.hasOwnProperty.call(objValues, id)) {
						// write current val to state
						if (deviceTypes[id].convertVal) {
							await this.setStateChangedAsync(`${parent}.${channel}.${id}`, deviceTypes[id].convertVal(objValues[id]), true);
						} else {
							await this.setStateChangedAsync(`${parent}.${channel}.${id}`, objValues[id], true);
						}
					} else {
						if (!Object.prototype.hasOwnProperty.call(deviceTypes[id], 'id')) {
							// only report it if it's not a custom defined state
							this.log.warn(`${logPrefix} property '${channel}.${id}' not exists in bootstrap values`);
						}
					}
				} else {
					// it's a channel, create it and iterate again over the properties
					if (!await this.objectExists(`${parent}.${channel}.${id}`)) {
						this.log.debug(`${logPrefix} creating channel '${parent}.${channel}.${id}'`);

						await this.setObjectAsync(`${parent}.${channel}.${id}`, {
							type: 'channel',
							common: {
								name: id
							},
							native: {}
						});

					}
					await this.createGenericState(parent, `${channel}.${id}`, deviceTypes[id], objValues[id]);
				}
			}

		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}


	/** Update device values from event payload
	 * @param {any} idDevice id of device (e.g. camera id)
	 * @param {string} idParentDevice id of parent device (e.g. cameras)
	 * @param {object} deviceTypes defined states and types in {@link myDeviceTypes}
	 * @param {object} payload data from event
	 */
	async updateStates(idDevice, idParentDevice, deviceTypes, payload, idPrefix = '') {
		const logPrefix = '[updateStates]:';

		try {
			for (const key in payload) {
				if (deviceTypes[key]) {
					if (Object.prototype.hasOwnProperty.call(deviceTypes[key], 'type')) {
						const id = `${idParentDevice}.${idDevice}${idPrefix}.${key}`;
						const val = deviceTypes[key].convertVal ? deviceTypes[key].convertVal(payload[key]) : payload[key];

						if (this.log.level === 'debug') {
							// ToDo: change to silly level
							const oldState = await this.getStateAsync(id);

							if (oldState && oldState.val !== val) {
								this.log.silly(`${logPrefix} ${this.ufp?.getDeviceName(this.devices.cameras[idDevice])} - update state '${idPrefix}.${key}': ${val} (oldVal: ${oldState.val})`);
							}
						}

						if (await this.objectExists(id)) // check, as id may be on blacklist
							await this.setStateChangedAsync(id, val, true);
					} else {
						await this.updateStates(idDevice, idParentDevice, deviceTypes[key], payload[key], `${idPrefix}.${key}`);
					}
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	/** Set adapter info.connection state and internal var
	 * @param {boolean} isConnected
	 */
	async setConnectionStatus(isConnected) {
		const logPrefix = '[setConnectionStatus]:';

		try {
			this.isConnected = isConnected;
			await this.setStateAsync('info.connection', isConnected, true);
		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}

	/** check if state exists before setting value
	 * @param {string} id
	 * @param {any} val
	 */
	async setStateExists(id, val) {
		const logPrefix = '[setThumbState]:';

		try {
			if (await this.objectExists(id)) {
				await this.setStateAsync(id, val, true);
			}

		} catch (error) {
			this.log.error(`${logPrefix} ${error}`);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new UnifiProtectNvr(options);
} else {
	// otherwise start the instance directly
	new UnifiProtectNvr();
}