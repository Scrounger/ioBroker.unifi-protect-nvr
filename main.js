'use strict';

/*
 * Created with @iobroker/create-adapter v2.6.3
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const moment = require('moment');

const myDeviceTypes = require('./lib/devices');
const myDeviceImages = require('./lib/deviceImages');
const myHelper = require('./lib/helper');


const fs = require('fs');

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
			useFormatDate: true
		});

		this.isConnected = false;
		this.ufp = undefined;
		this.ufpLog = {
			debug: (message, ...parameters) => this.log.debug(`[ufp API]: ${message}${parameters && parameters.length > 0 ? ` - ${JSON.stringify(parameters)}` : ''}`),
			error: (message, ...parameters) => this.log.error(`[ufp API]: ${message}${parameters && parameters.length > 0 ? ` - ${JSON.stringify(parameters)}` : ''}`),
			info: (message, ...parameters) => this.log.info(`[ufp API]: ${message}${parameters && parameters.length > 0 ? ` - ${JSON.stringify(parameters)}` : ''}`),
			warn: (message, ...parameters) => this.log.debug(`[ufp API]: ${message}${parameters && parameters.length > 0 ? ` - ${JSON.stringify(parameters)}` : ''}`)
		};
		this.ufpEventsToIgnore = [
			'videoExported',
			'update',
			'recordingModeChanged',
			'resolutionChanged',
			'resolutionLowered',
			'poorConnection',
			'provision',
			'deviceUnadopted',
			'disconnect',
			'nonScheduledRecording',
			'cameraPowerCycling',
			'factoryReset',
			'videoCodecChanged'
		];

		this.ufpLiveStream = {};

		this.devices = {
			nvr: {},
			cameras: {},
			users: {},
			sensors: {}
		};

		this.devicesById = {};

		this.eventStore = {
			cameras: {}
		};

		this.aliveInterval = 15;
		this.aliveTimeout = null;
		this.aliveTimestamp = moment().valueOf();

		this.retentionTimeout = null;

		this.connectionMaxRetries = 200;
		this.connectionRetries = 0;

		this.paths = {
			eventThumb: '/proxy/protect/api/events/{0}/thumbnail',
			eventAnimatedThumb: '/proxy/protect/api/events/{0}/animated-thumbnail'
		};

		this.defaultImage = {
			snapshot: '',
			thumbnail: '',
			thumbnailAnimated: ''
		};

		this.storagePaths = {
			snapshotCameras: '/snapshot/cameras/'
		};

		this.fileNameFormat = 'YYYY_MM_DD_HH_mm_ss';

		this.configFilterList = [];		// List for AutoComplete in adapter settings
		this.configFilterListIgnore = ['cameras', 'nvr'];
		this.blacklistedStates = [];	// prepared List for filtering out states

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/** Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		const logPrefix = '[onReady]:';

		try {
			moment.locale(this.language);

			this.setDefaultImages();

			await this.prepareBlacklistedStates();

			if (this.config.host, this.config.user, this.config.password) {
				this.log.debug(`${logPrefix} Loading unifi-protect ESM Module dynamically`);

				const UnifiProtectImport = (await import('unifi-protect')).ProtectApi;
				this.ufp = new UnifiProtectImport(this.ufpLog);

				// listen to realtime events (must be given as function to be able to use this)
				this.ufp.on('message', (event) => this.onProtectEvent(event));

				await this.establishConnection(true);
			} else {
				this.log.warn(`${logPrefix} no login credentials in adapter config set!`);
			}

			this.retentionManager();

		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		const logPrefix = '[onUnload]:';
		try {
			// Here you must clear all timeouts or intervals that may still be active
			if (this.aliveTimeout) clearTimeout(this.aliveTimeout);
			if (this.retentionTimeout) clearTimeout(this.retentionTimeout);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);
			if (this.ufp) {
				this.ufp.reset();
				this.setConnectionStatus(false, false);
				this.log.info(`${logPrefix} Logged out successfully from the Unifi-Protect controller API. (host: ${this.config.host})`);
			}

			callback();

			// eslint-disable-next-line no-unused-vars
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

	/** Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		const logPrefix = '[onStateChange]:';
		try {
			if (this.isConnected && this.ufp) {

				if (state && !state.from.includes(this.namespace)) {
					// The state was changed
					if (id.includes(`${this.namespace}.cameras`)) {
						const camMac = id.split('.')[3];

						if (id.includes(myDeviceTypes.cameras.takeSnapshot.id)) {
							// Camera's: takt a snapshot and store it
							this.getSnapshot(this.devices.cameras[camMac], `cameras.${camMac}.${myDeviceTypes.cameras.takeSnapshotUrl.id}`, this.config.manualSnapshotWidth, this.config.manualSnapshotHeight);

							// } else if (id.split('.').pop()?.includes(myDeviceTypes.cameras.channels.items.streamStart.id) || id.split('.').pop()?.includes(myDeviceTypes.cameras.channels.items.streamStop.id)) {
							// 	const camId = this.devices.cameras[camMac].id;

							// 	this.ufpLiveStream[camId] = this.ufp.createLivestream();

							// 	if (id.split('.').pop()?.includes(myDeviceTypes.cameras.channels.items.streamStart.id)) {
							// 		let res = await this.ufpLiveStream[camId].start(camId, 0);

							// 		if (res) {
							// 			this.log.warn(this.ufpLiveStream[camId].ws._url);
							// 			this.setStateExists(id.replace(`.${myDeviceTypes.cameras.channels.items.streamStart.id}`, `.${myDeviceTypes.cameras.channels.items.streamUrl.id}`), this.ufpLiveStream[camId].ws._url, true);
							// 		}
							// 	} else {
							// 		this.log.warn('stop!');
							// 		await this.ufpLiveStream[camId].stop();
							// 		this.setStateExists(id.replace(`.${myDeviceTypes.cameras.channels.items.streamStop.id}`, `.${myDeviceTypes.cameras.channels.items.streamUrl.id}`), null, true);
							// 	}

						} else {
							// Camera's: write values
							if (this.devices.cameras[camMac]) {
								const writeValFunction = myHelper.getObjectByString(`${id.split(`${camMac}.`).pop()}.writeVal`, myDeviceTypes.cameras, '.');

								await this.onStateChangedUfp(this.devices.cameras[camMac], id, state,
									myHelper.strToObj(id.split(`${camMac}.`).pop(), writeValFunction ? writeValFunction(state.val) : state.val));

							} else {
								this.log.error(`${logPrefix} cam (mac: ${camMac}) not exists in devices list`);
							}
						}

					} else if (id.includes(`${this.namespace}.nvr`)) {
						// NVR: write values
						if (this.devices.nvr) {
							const writeValFunction = myHelper.getObjectByString(`${id.split(`nvr.`).pop()}.writeVal`, myDeviceTypes.nvr, '.');

							await this.onStateChangedUfp(this.devices.nvr, id, state,
								myHelper.strToObj(id.split(`nvr.`).pop(), writeValFunction ? writeValFunction(state.val) : state.val));
						}

					} else if (id.includes(`${this.namespace}.users`)) {
						const userId = id.split('.')[3];

						if (this.devices.users[userId]) {
							// User's: write values
							const writeValFunction = myHelper.getObjectByString(`${id.split(`${userId}.`).pop()}.writeVal`, myDeviceTypes.users, '.');

							await this.onStateChangedUfp(this.devices.users[userId], id, state,
								myHelper.strToObj(id.split(`${userId}.`).pop(), writeValFunction ? writeValFunction(state.val) : state.val));
						} else {
							this.log.error(`${logPrefix} user (id: ${userId}) not exists in devices list`);
						}

					} else if (id.includes(`${this.namespace}.sensors`)) {
						const sensorMac = id.split('.')[3];

						// Sensor's: write values
						if (this.devices.sensors[sensorMac]) {
							const writeValFunction = myHelper.getObjectByString(`${id.split(`${sensorMac}.`).pop()}.writeVal`, myDeviceTypes.sensors, '.');

							await this.onStateChangedUfp(this.devices.sensors[sensorMac], id, state,
								myHelper.strToObj(id.split(`${sensorMac}.`).pop(), writeValFunction ? writeValFunction(state.val) : state.val));

						} else {
							this.log.error(`${logPrefix} sensor (mac: ${sensorMac}) not exists in devices list`);
						}

					} else {
						this.log.warn(`${logPrefix} not implemented: state ${id} changed: ${state.val} (ack = ${state.ack})!`);
					}
				} else {
					// The state was deleted
					// this.log.info(`state ${id} deleted`);
				}
			} else {
				this.log.warn(`${logPrefix} No Connection to the Unifi-Controller, '${id}' cannot be written!`);
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Send state changed to nvr using ufp
	 * @param {object} device
	 * @param {string} id
	 * @param {ioBroker.State} state
	 * @param {object} objWrite
	 */
	async onStateChangedUfp(device, id, state, objWrite, secondRun = false) {
		const logPrefix = '[onStateChangedUfp]:';
		try {
			if (this.ufp) {
				const response = await this.ufp.updateDevice(device, objWrite);

				this.log.silly(`${logPrefix} response: ${JSON.stringify(response)}`);

				if (response !== null) {
					this.log.debug(`${logPrefix} ${this.ufp.getDeviceName(device)} - state '.${id.split('.')?.slice(3)?.join('.')}' changed, objWrite: ${JSON.stringify(objWrite)}`);
					this.log.info(`${logPrefix} ${this.ufp.getDeviceName(device)} - state '.${id.split('.')?.slice(3)?.join('.')}' changed to '${state.val}'${secondRun ? ' (2nd try)' : ''}`);

					return true;
				} else {
					this.log.warn(`${logPrefix} response: ${JSON.stringify(response)}`);
					this.log.warn(`${logPrefix} ${this.ufp.getDeviceName(device)} - changing state${secondRun ? ' (2nd try)' : ''} '${id}' to '${state.val}' not successful!`);

					if (!secondRun && this.config.stateChangeRetryDelay > 0) {
						const that = this;
						setTimeout(async function () {
							await that.onStateChangedUfp(device, id, state, objWrite, true);
						}, this.config.stateChangeRetryDelay * 1000);
					}
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}

		return false;
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	async onMessage(obj) {
		// this.log.warn(JSON.stringify(obj.command));
		if (typeof obj === 'object' && obj.message) {
			if (obj.command === 'filterList') {
				if (this.configFilterList.length === 0) {
					await this.createConfigFilterList(myDeviceTypes);
				}

				// Send response in callback if required
				if (obj.callback) this.sendTo(obj.from, obj.command, this.configFilterList, obj.callback);
			} else if (obj.command === 'jsonBootstrap') {
				if (await this.ufp?.getBootstrap()) {
					if (obj.callback) this.sendTo(obj.from, obj.command, JSON.stringify(this.ufp?.bootstrap, null, '\t'), obj.callback);
				} else {
					if (obj.callback) this.sendTo(obj.from, obj.command, 'no data retrieved!', obj.callback);
				}
			}
		}
	}

	/** Establish Connection to NVR and starting the alive checker
	 * @param {boolean} isAdapterStart
	 */
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
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Login into NVR and load bootstrap data
	 * @returns {Promise<boolean>} Connection status
	 */
	async login() {
		const logPrefix = '[login]:';

		try {
			if (this.ufp) {
				const loginSuccessful = await this.ufp.login(this.config.host, this.config.user, this.config.password);

				if (loginSuccessful) {
					this.log.info(`${logPrefix} Logged in successfully to the Unifi-Protect controller API. (host: ${this.config.host})`);

					if (await this.ufp.getBootstrap()) {
						this.log.debug(`${logPrefix} successfully received bootstrap`);
						await this.setConnectionStatus(true, this.ufp.isThrottled);

						return true;
					} else {
						this.log.error(`${logPrefix} Unable to bootstrap the Unifi-Protect controller API`);
					}
				} else {
					this.log.error(`${logPrefix} Login to the Unifi-Protect controller API failed! (host: ${this.config.host})`);
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}

		await this.setConnectionStatus(false, false);

		return false;
	}

	async getDevices(isAdapterStart) {
		const logPrefix = '[getDevices]:';

		try {
			if (this.ufp && this.ufp.bootstrap) {
				this.log.silly(`bootstrap: ${JSON.stringify(this.ufp.bootstrap)}`);

				if (this.ufp.bootstrap.nvr) {
					// perhaps needed for hasFeature stuff
					this.devices.nvr = this.ufp.bootstrap.nvr;
					this.devicesById[this.ufp.bootstrap.nvr.id] = this.devices.nvr;

					if (this.config.nvrEnabled) {
						this.log.info(`${logPrefix}: Discovered ${this.ufp.bootstrap.nvr.modelKey}: ${this.ufp.getDeviceName(this.ufp.bootstrap.nvr, this.ufp.bootstrap.nvr.name)} (IP: ${this.ufp.bootstrap.nvr.host}, mac: ${this.ufp.bootstrap.nvr.mac}, id: ${this.ufp.bootstrap.nvr.id})`);

						if (isAdapterStart) {
							await this.createNvrStates(this.ufp.bootstrap.nvr);
						}

						this.log.silly(`${logPrefix} devices.nvr: ${JSON.stringify(this.devices.nvr)}`);
					} else {
						if (isAdapterStart && await this.objectExists('nvr')) {
							await this.delObjectAsync('nvr', { recursive: true });
							this.log.info(`${logPrefix} NVR states deleted, because it's not enabled in the adapter configuration`);
						}
					}
				}

				// Add Cameras to List
				if (this.ufp.bootstrap.cameras) {
					if (this.config.camerasEnabled) {
						for (const cam of this.ufp.bootstrap.cameras) {
							this.log.info(`${logPrefix}: Discovered ${cam.modelKey}: ${this.ufp.getDeviceName(cam, cam.name)} (IP: ${cam.host}, mac: ${cam.mac}, id: ${cam.id}, state: ${cam.state})`);
							this.devices.cameras[cam.mac] = cam;
							this.devicesById[cam.id] = this.devices.cameras[cam.mac];

							if (isAdapterStart) {
								await this.createCameraStates(cam);
							}
						}
						this.log.silly(`${logPrefix} devices.cameras: ${JSON.stringify(this.devices.cameras)}`);

						if (this.config.motionEventsEnabled && this.config.motionEventsHistoryEnabled) {
							await this.createMotionHistoryChannels();
						} else {
							if (isAdapterStart && await this.objectExists('events.motion')) {
								await this.delObjectAsync('events.motion', { recursive: true });
								this.log.info(`${logPrefix} Motion event states deleted, because it's not enabled in the adapter configuration`);
							}
						}
					} else {
						if (isAdapterStart && await this.objectExists('cameras')) {
							await this.delObjectAsync('cameras', { recursive: true });
							this.log.info(`${logPrefix} Camera states deleted, because it's not enabled in the adapter configuration`);
						}
					}
				}

				// Add Users to List
				if (this.ufp.bootstrap.users) {
					if (this.config.usersEnabled) {
						for (const user of this.ufp.bootstrap.users) {
							this.log.info(`${logPrefix}: Discovered ${user.modelKey}: ${user.name}`);
							this.devices.users[user.id] = user;

							if (isAdapterStart) {
								await this.createUserStates(user);
							}
						}
						this.log.silly(`${logPrefix} devices.users: ${JSON.stringify(this.devices.users)}`);
					} else {
						if (isAdapterStart && await this.objectExists('users')) {
							await this.delObjectAsync('users', { recursive: true });
							this.log.info(`${logPrefix} User states deleted, because it's not enabled in the adapter configuration`);
						}
					}
				}

				// Add Sensors to List
				if (this.ufp.bootstrap.sensors) {
					if (this.config.sensorsEnabled) {
						for (const sensor of this.ufp.bootstrap.sensors) {
							this.log.info(`${logPrefix}: Discovered ${sensor.modelKey}: ${sensor.name}`);
							this.devices.sensors[sensor.mac] = sensor;
							this.devicesById[sensor.id] = this.devices.sensors[sensor.mac];

							if (isAdapterStart) {
								await this.createSensorStates(sensor);
							}
						}
						this.log.silly(`${logPrefix} devices.sensors: ${JSON.stringify(this.devices.sensors)}`);
					}
				}

			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** ufp Api Event Handler
	 @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectEventPacket} event
	 */
	async onProtectEvent(event) {
		const logPrefix = '[onProtectEvent]:';

		try {
			this.aliveTimestamp = moment().valueOf();

			// this.log.warn(JSON.stringify(event));

			if (this.config.camerasEnabled && event.header.modelKey === 'camera') {
				const camId = event.header.id;
				if (this.devicesById[camId]) {
					await this.updateStates(this.devicesById[camId].mac, 'cameras', this.devicesById[camId], myDeviceTypes.cameras, event.payload);
				} else {
					if (event && event.payload && event.payload.type)
						this.log.warn(`${logPrefix} unknown device (id: ${camId}, type: ${event.payload.type}). Please restart the adapter to detect new devices`);
				}
			} else if (event.header.modelKey === 'event') {
				if (this.config.camerasEnabled && this.config.motionEventsEnabled && event.header.recordModel === 'camera') {
					const camId = event.header.recordId;

					if (this.devicesById[camId]) {
						const cam = this.devicesById[event.header.recordId];
						this.onCamMotionEvent(cam, event.header, event.payload);
					} else {
						if (event && event.payload && event.payload.type)
							this.log.warn(`${logPrefix} unknown device (id: ${camId}, type: ${event.payload.type}). Please restart the adapter to detect new devices`);
					}
				}
			} else if (this.config.nvrEnabled && event.header.modelKey === 'nvr') {
				await this.updateStates('nvr', undefined, this.devices.nvr, myDeviceTypes.nvr, event.payload);

			} else if (this.config.usersEnabled && event.header.modelKey === 'user') {
				const userId = event.header.id;
				await this.updateStates(userId, 'users', this.devices.users[userId], myDeviceTypes.users, event.payload);

				// this.log.warn(`header: ${JSON.stringify(event.header)}, payload: ${JSON.stringify(event.payload)}`);
			} else if (this.config.sensorsEnabled && event.header.modelKey === 'sensor') {
				const sensorId = event.header.id;
				if (this.devicesById[sensorId]) {
					await this.updateStates(this.devicesById[sensorId].mac, 'sensors', this.devicesById[sensorId], myDeviceTypes.sensors, event.payload);
				} else {
					if (event && event.payload && event.payload.type)
						this.log.warn(`${logPrefix} unknown device (id: ${sensorId}, type: ${event.payload.type}). Please restart the adapter to detect new devices`);
				}

				// this.log.warn(`header: ${JSON.stringify(event.header)}, payload: ${JSON.stringify(event.payload)}`);
			} else {
				this.log.silly(`header: ${JSON.stringify(event.header)}, payload: ${JSON.stringify(event.payload)}`);
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Camera Motion Event Handler
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectCameraConfigInterface} cam
	 * @param {{ action?: string; id: any; modelKey?: string; newUpdateId?: string; mac?: string | undefined; nvrMac?: string | undefined; recordModel?: string | undefined; recordId?: string | undefined; }} header
	 * @param {object} payload
	 */
	async onCamMotionEvent(cam, header, payload) {
		const logPrefix = '[onMotionEvent]:';

		try {
			// motion events consist multiple events
			if (this.ufp) {
				// ToDo: log level silly
				this.log.debug(`${logPrefix} ${this.ufp.getDeviceName(cam)} - eventId: ${header.id}, payload: ${JSON.stringify(payload)}`);

				if (payload.type === 'motion' || payload.type === 'smartDetectZone' || payload.type === 'smartDetectLine' || this.eventStore.cameras[header.id]) {
					const camMac = `cameras.${cam.mac}`;

					if (Object.prototype.hasOwnProperty.call(payload, 'start')) {
						// Motion event start -> start property is available

						this.log.debug(`${logPrefix} ${this.ufp.getDeviceName(cam)} - motion event start (type: ${payload.type})`);

						this.eventStore.cameras[header.id] = {
							// properties must be equal to the defined properties in {@link myDeviceTypes} -> used in function 'setCustomMotionEventStates'
							lastMotionEventId: header.id,
							snapshotTaken: false,
							lastMotionType: payload.type,
							lastMotionScore: payload.score ? payload.score : 0,
							lastMotionSmartTypes: payload.smartDetectTypes && payload.smartDetectTypes.length > 0 ? payload.smartDetectTypes : ['none'],
							lastMotionStart: payload.start,
							lastMotionEnd: null,
							lastMotionSnapshot: this.config.motionSnapshot ? this.defaultImage.snapshot : null,
							lastMotionThumbnail: this.config.motionThumb ? this.defaultImage.thumbnail : null,
							lastMotionThumbnailAnimated: this.config.motionThumbAnimated ? this.defaultImage.thumbnailAnimated : null
						};

						// set custom states - using eventStore because conversions may be defined here
						await this.setCustomMotionEventStates('cameras', cam, this.eventStore.cameras[header.id]);

						if (this.config.motionEventsHistoryEnabled) {
							await this.setCustomMotionEventStates('events.motion', cam, this.eventStore.cameras[header.id], true, true);
						}

						// Snapshot Delay configured
						if (this.config.motionSnapshot && this.config.motionSnapshotDelay >= 0 && !this.eventStore.cameras[header.id].snapshotTaken) {
							setTimeout(async () => {
								delete this.eventStore.cameras[header.id].lastMotionSnapshot;	// delete from object to prevent override with default image

								await this.getSnapshot(cam, `${camMac}.${myDeviceTypes.cameras.lastMotionSnapshot.id}`, this.config.motionSnapshotWidth, this.config.motionSnapshotHeight, true,
									this.config.motionEventsHistoryEnabled, `events.motion.${header.id}.${myDeviceTypes.cameras.lastMotionSnapshot.id.replace('lastMotion.', '')}`);
								this.eventStore.cameras[header.id].snapshotTaken = true;

							}, this.config.motionSnapshotDelay * 1000);
						}
					} else {
						// following events, have the same eventId
						if (this.eventStore.cameras[header.id]) {
							this.eventStore.cameras[header.id].lastMotionScore = payload.score ? payload.score : this.eventStore.cameras[header.id].lastMotionScore;
							this.eventStore.cameras[header.id].lastMotionEnd = payload.end ? payload.end : this.eventStore.cameras[header.id].lastMotionEnd;
							this.eventStore.cameras[header.id].lastMotionSmartTypes = payload.smartDetectTypes ? payload.smartDetectTypes : this.eventStore.cameras[header.id].lastMotionSmartTypes;

							// Snapshot configured -1 = auto
							if (this.config.motionSnapshot && this.config.motionSnapshotDelay === -1 && !this.eventStore.cameras[header.id].snapshotTaken) {
								delete this.eventStore.cameras[header.id].lastMotionSnapshot;	// delete from object to prevent override with default image

								await this.getSnapshot(cam, `${camMac}.${myDeviceTypes.cameras.lastMotionSnapshot.id}`, this.config.motionSnapshotWidth, this.config.motionSnapshotHeight, true,
									this.config.motionEventsHistoryEnabled, `events.motion.${header.id}.${myDeviceTypes.cameras.lastMotionSnapshot.id.replace('lastMotion.', '')}`);
								this.eventStore.cameras[header.id].snapshotTaken = true;

							}

							// Motion event finished -> paylod have 'metadata.detectedThumbnails'
							if (Object.prototype.hasOwnProperty.call(payload, 'metadata') && Object.prototype.hasOwnProperty.call(payload['metadata'], 'detectedThumbnails')) {
								this.log.debug(`${logPrefix} ${this.ufp.getDeviceName(cam)} - motion event finished (eventStore: ${JSON.stringify(this.eventStore.cameras[header.id])})`);

								// set custom states - using eventStore because conversions may be defined here
								await this.setCustomMotionEventStates('cameras', cam, this.eventStore.cameras[header.id], true);

								if (this.config.motionThumb) {
									delete this.eventStore.cameras[header.id].lastMotionThumbnail;	// delete from object to prevent override with default image

									await this.getEventThumb(cam, `${camMac}.${myDeviceTypes.cameras.lastMotionThumbnail.id}`, header.id, this.config.motionThumbWidth, this.config.motionThumbHeight,
										this.config.motionEventsHistoryEnabled, `events.motion.${header.id}.${myDeviceTypes.cameras.lastMotionThumbnail.id.replace('lastMotion.', '')}`);
								}

								if (this.config.motionThumbAnimated) {
									delete this.eventStore.cameras[header.id].lastMotionThumbnailAnimated;	// delete from object to prevent override with default image

									this.setTimeout(async () => {
										await this.getEventAnimatedThumb(cam, `${camMac}.${myDeviceTypes.cameras.lastMotionThumbnailAnimated.id}`, header.id, this.config.motionThumbAnimatedWidth, this.config.motionThumbAnimatedHeight, this.config.motionThumbAnimatedSpeedUp,
											this.config.motionEventsHistoryEnabled, `events.motion.${header.id}.${myDeviceTypes.cameras.lastMotionThumbnailAnimated.id.replace('lastMotion.', '')}`);
									}, 5 * 1000);
								}

								if (this.config.motionEventsHistoryEnabled) {
									await this.setCustomMotionEventStates('events.motion', cam, this.eventStore.cameras[header.id], true, true);
								}

								delete this.eventStore.cameras[header.id];
							}
						}
					}
				} else if (Object.prototype.hasOwnProperty.call(payload, 'type')) {
					if (!this.ufpEventsToIgnore.includes(payload.type)) {
						this.log.warn(`${logPrefix} ${this.ufp.getDeviceName(cam)} - event from type '${payload.type}' is not implemented! Please report this to the developer (header: ${JSON.stringify(header)}, payload: ${JSON.stringify(payload)})`);
					} else {
						this.log.debug(`${logPrefix} ${this.ufp.getDeviceName(cam)} - event from type '${payload.type}' is on the events ignore list. (header: ${JSON.stringify(header)}, payload: ${JSON.stringify(payload)})`);
					}
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** get thumb of motion event
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectCameraConfigInterface} cam
	 * @param {string} targetId
	 * @param {string} eventId
	 * @param {number} width
	 * @param {number} height
	 * @param {boolean} isHistorieEnabled
	 * @param {string | undefined} historyId
	 */
	async getEventThumb(cam, targetId, eventId, width, height, isHistorieEnabled = false, historyId = undefined) {
		if (this.ufp && this.isConnected) {
			const logPrefix = `[getEventThumb]: ${this.ufp.getDeviceName(cam)} - `;

			try {
				const url = `https://${this.config.host}${this.paths.eventThumb.replace('{0}', eventId)}?w=${width}&h=${height}`;
				const response = await this.ufp.retrieve(url, undefined, true);

				// response is from type Fetch (https://github.com/hjdhjd/unifi-protect/blob/main/docs/ProtectApi.md#retrieve)
				if (response) {
					if (response.ok) {
						const imageBuffer = Buffer.from(await response.arrayBuffer());
						const imageBase64 = imageBuffer.toString('base64');
						const base64ImgString = `data:image/jpeg;base64,` + imageBase64;

						this.log.debug(`${logPrefix} thumb successfully stored in state '.${targetId.split('.')?.slice(1)?.join('.')}'`);

						await this.setStateExists(targetId, base64ImgString);

						if (isHistorieEnabled && historyId) {
							await this.setStateExists(historyId, base64ImgString);
							this.log.debug(`${logPrefix} thumb successfully stored in state '.${historyId.split('.')?.slice(1)?.join('.')}'`);
						}
					} else {
						this.log.error(`${logPrefix} response code: ${response.status}`);
					}
				} else {
					this.log.warn(`${logPrefix} no response from the server, no thumb found!`);
				}

			} catch (error) {
				this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
			}
		}
	}

	/** get animated thumb of motion event
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectCameraConfigInterface} cam
	 * @param {string} targetId
	 * @param {string} eventId
	 * @param {number} width
	 * @param {number} height
	 * @param {number} speedup
	 * @param {boolean} isHistorieEnabled
	 * @param {string | undefined} historyId
	 */
	async getEventAnimatedThumb(cam, targetId, eventId, width, height, speedup, isHistorieEnabled = false, historyId = undefined) {
		if (this.ufp && this.isConnected) {
			const logPrefix = `[getEventAnimatedThumb]: ${this.ufp.getDeviceName(cam)} - `;

			try {
				const url = `https://${this.config.host}${this.paths.eventAnimatedThumb.replace('{0}', eventId)}?w=${width}&h=${height}&keyFrameOnly=true&speedup=${speedup}`;
				const response = await this.ufp.retrieve(url, undefined, true);

				// response is from type Fetch (https://github.com/hjdhjd/unifi-protect/blob/main/docs/ProtectApi.md#retrieve)
				if (response) {
					if (response.ok) {
						const imageBuffer = Buffer.from(await response.arrayBuffer());
						const imageBase64 = imageBuffer.toString('base64');
						const base64ImgString = `data:image/gif;base64,` + imageBase64;

						this.log.debug(`${logPrefix} animated thumb successfully stored in state '.${targetId.split('.')?.slice(1)?.join('.')}'`);

						await this.setStateExists(targetId, base64ImgString);

						if (isHistorieEnabled && historyId) {
							await this.setStateExists(historyId, base64ImgString);
							this.log.debug(`${logPrefix} animated thumb successfully stored in state '.${historyId.split('.')?.slice(1)?.join('.')}'`);
						}
					} else {
						this.log.error(`${logPrefix} response code: ${response.status}`);
					}
				} else {
					this.log.warn(`${logPrefix} no response from the server, no thumb found!`);
				}

			} catch (error) {
				this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
			}
		}
	}

	/** take a snap shot using the ufp lib
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectCameraConfigInterface} cam
	 * @param {string} targetId state where the base64 image or url should be stored
	 * @param {number} width
	 * @param {number} height
	 * @param {boolean} base64Image
	 * @param {boolean} isHistorieEnabled
	 * @param {string | undefined} historyId
	 */
	async getSnapshot(cam, targetId, width, height, base64Image = false, isHistorieEnabled = false, historyId = undefined) {
		if (this.ufp && this.isConnected) {
			const logPrefix = `[getSnapshot]: ${this.ufp.getDeviceName(cam)} - `;

			try {
				const now = moment();
				const imageBuffer = await this.ufp.getSnapshot(cam, width, height, now.valueOf());

				if (imageBuffer) {
					if (base64Image) {
						const imageBase64 = imageBuffer.toString('base64');
						const base64ImgString = `data:image/jpeg;base64,` + imageBase64;

						this.log.debug(`${logPrefix} snapshot successfully stored in state '.${targetId.split('.')?.slice(1)?.join('.')}'`);

						await this.setStateExists(targetId, base64ImgString);

						if (isHistorieEnabled && historyId) {
							await this.setStateExists(historyId, base64ImgString);
							this.log.debug(`${logPrefix} snapshot successfully stored in state '.${historyId.split('.')?.slice(1)?.join('.')}'`);
						}
					} else {
						const filename = `${this.storagePaths.snapshotCameras}${cam.displayName.replaceAll(' ', '_')}_${cam.mac}/${now.format(this.fileNameFormat)}.png`;

						await this.writeFileAsync(this.namespace, filename, imageBuffer);

						this.log.info(`${logPrefix} snapshot successfully received (/${this.namespace}${filename})`);

						await this.setStateExists(targetId, `/${this.namespace}${filename}`);
					}
				}
			} catch (error) {
				this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
			}
		}
	}

	/** Check whether the connection to the controller exists, if not try to establish a new connection
	 */
	async aliveChecker() {
		const logPrefix = '[aliveChecker]:';

		try {
			if (this.ufp) {
				const diff = Math.round((moment().valueOf() - this.aliveTimestamp) / 1000);

				if (diff >= this.aliveInterval) {
					this.log.warn(`${logPrefix} No connection to the Unifi-Protect controller -> restart connection (retries: ${this.connectionRetries})`);
					this.ufp.reset();

					await this.setConnectionStatus(false, this.ufp.isThrottled);

					if (this.connectionRetries < this.connectionMaxRetries) {
						this.connectionRetries++;

						await this.establishConnection();
					} else {
						this.log.error(`${logPrefix} Connection to the Unifi-Protect controller is down for more then ${this.connectionMaxRetries * this.aliveInterval}s, stopping the adapter.`);
						this.stop({ reason: 'too many connection retries' });
					}
				} else {
					this.log.silly(`${logPrefix} Connection to the Unifi-Protect controller is alive (last alive signal is ${diff}s old)`);

					await this.setConnectionStatus(true, this.ufp.isThrottled);
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
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}


	/** Create nvr states
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectNvrConfigInterface} nvr
	 */
	async createNvrStates(nvr) {
		const logPrefix = '[createNvrStates]:';

		try {
			if (this.ufp) {
				const common = {
					name: this.ufp.getDeviceName(nvr, nvr.name),
					icon: myDeviceImages[nvr.type] ? myDeviceImages[nvr.type] : null
				};

				if (!await this.objectExists(`nvr`)) {
					this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(nvr)} - creating channel '${nvr.id}' for nvr '${this.ufp.getDeviceName(nvr, nvr.name)}'`);
					await this.setObjectAsync('nvr', {
						type: 'channel',
						common: common,
						native: {}
					});
				} else {
					const obj = await this.getObjectAsync(`nvr`);

					if (obj && obj.common) {
						//@ts-ignore
						if (!myHelper.isChannelCommonEqual(obj.common, common)) {
							await this.extendObject(`nvr`, { common: common });
							this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(nvr)} - channel updated '.nvr'`);
						}
					}
				}

				await this.createGenericState('nvr', myDeviceTypes.nvr, nvr, 'nvr', nvr);
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Create camera states
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectCameraConfigInterface} cam
	 */
	async createCameraStates(cam) {
		const logPrefix = '[createCameraStates]:';

		try {
			if (this.ufp) {
				if (!await this.objectExists(`cameras`)) {
					await this.extendObject(`cameras`, {
						type: 'device',
						common: {
							name: 'Camera\'s',
							icon: myDeviceImages.Cameras
						}
					});
				}

				const common = {
					name: this.ufp.getDeviceName(cam, cam.name),
					icon: myDeviceImages[cam.type] ? myDeviceImages[cam.type] : null
				};

				if (!await this.objectExists(`cameras.${cam.mac}`)) {
					// create cam channel
					this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(cam)} - creating channel '${cam.mac}' for camera '${this.ufp.getDeviceName(cam, cam.name)}'`);

					await this.setObjectAsync(`cameras.${cam.mac}`, {
						type: 'channel',
						common: common,
						native: {}
					});
				} else {
					const obj = await this.getObjectAsync(`cameras.${cam.mac}`);

					if (obj && obj.common) {
						//@ts-ignore
						if (!myHelper.isChannelCommonEqual(obj.common, common)) {
							await this.extendObject(`cameras.${cam.mac}`, { common: common });
							this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(cam)} - channel updated '.${cam.mac}'`);
						}
					}
				}

				await this.createGenericState(`cameras.${cam.mac}`, myDeviceTypes.cameras, cam, 'cameras', cam);
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Create user states
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectNvrUserConfigInterface} user
	 */
	async createUserStates(user) {
		const logPrefix = '[createCameraStates]:';

		try {
			if (this.ufp) {
				const common = {
					name: user.name
				};

				if (!await this.objectExists(`users`)) {
					await this.extendObject(`users`, {
						type: 'device',
						common: {
							name: 'User\'s',
							icon: myDeviceImages.Users
						}
					});
				}

				if (!await this.objectExists(`users.${user.id}`)) {
					// create user channel
					this.log.debug(`${logPrefix} ${user.name} - creating channel '${user.id}' for user '${user.name}'`);

					await this.setObjectAsync(`users.${user.id}`, {
						type: 'channel',
						common: common,
						native: {}
					});
				} else {
					const obj = await this.getObjectAsync(`users.${user.id}`);

					if (obj && obj.common) {
						//@ts-ignore
						if (!myHelper.isChannelCommonEqual(obj.common, common)) {
							await this.extendObject(`users.${user.id}`, { common: common });
							this.log.debug(`${logPrefix} ${user.name} - channel updated '.${user.id}'`);
						}
					}
				}

				await this.createGenericState(`users.${user.id}`, myDeviceTypes.users, user, 'users', user);
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}


	/** Create sensor states
 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectSensorConfigInterface} sensor
 */
	async createSensorStates(sensor) {
		const logPrefix = '[createSensorStates]:';

		try {
			if (this.ufp) {
				if (!await this.objectExists(`sensors`)) {
					await this.extendObject(`sensors`, {
						type: 'device',
						common: {
							name: 'Sensors\'s',
							// icon: myDeviceImages.Cameras			//ToDo
						}
					});
				}

				const common = {
					name: this.ufp.getDeviceName(sensor, sensor.name),
					icon: myDeviceImages[sensor.type] ? myDeviceImages[sensor.type] : null
				};

				if (!await this.objectExists(`sensors.${sensor.mac}`)) {
					// create sensor channel
					this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(sensor)} - creating channel '${sensor.mac}' for sensor '${this.ufp.getDeviceName(sensor, sensor.name)}'`);

					await this.setObjectAsync(`sensors.${sensor.mac}`, {
						type: 'channel',
						common: common,
						native: {}
					});
				} else {
					const obj = await this.getObjectAsync(`sensors.${sensor.mac}`);

					if (obj && obj.common) {
						//@ts-ignore
						if (!myHelper.isChannelCommonEqual(obj.common, common)) {
							await this.extendObject(`sensors.${sensor.mac}`, { common: common });
							this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(sensor)} - channel updated '.${sensor.mac}'`);
						}
					}
				}

				await this.createGenericState(`sensors.${sensor.mac}`, myDeviceTypes.sensors, sensor, 'sensors', sensor);
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	async createMotionHistoryChannels() {
		const logPrefix = '[createMotionHistoryChannels]:';

		try {
			if (!await this.objectExists(`events`)) {
				await this.extendObject(`events`, {
					type: 'device',
					common: {
						name: 'Event\'s History',
						icon: myDeviceImages.Events
					}
				});
			}

			const common = {
				name: 'Motions Event\'s',
				icon: myDeviceImages.Motion
			};

			if (!await this.objectExists(`events.motion`)) {
				// create cam channel
				this.log.debug(`${logPrefix} creating channel 'events.motion'`);

				await this.setObjectAsync(`events.motion`, {
					type: 'channel',
					common: common,
					native: {}
				});
			} else {
				const obj = await this.getObjectAsync(`events.motion`);

				if (obj && obj.common) {
					//@ts-ignore
					if (!myHelper.isChannelCommonEqual(obj.common, common)) {
						await this.extendObject(`events.motion`, { common: common });
						this.log.debug(`${logPrefix} channel updated '.events.motion'`);
					}
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}



	/** Create all states for a devices, that are defined in {@link myDeviceTypes}
	 * @param {string} channel id of channel (e.g. camera id)
	 * @param {object} deviceTypes defined states and types in {@link myDeviceTypes}
	 * @param {object} objValues ufp bootstrap values of device
	 * @param {string} filterComparisonId id for filter
	 */
	async createGenericState(channel, deviceTypes, objValues, filterComparisonId, objOrg) {
		const logPrefix = '[createGenericState]:';

		try {
			// {@link myDevices}
			for (const id in deviceTypes) {
				let logMsgState = '.' + `${channel}.${id}`.split('.')?.slice(1)?.join('.');

				try {
					if (id && Object.prototype.hasOwnProperty.call(deviceTypes[id], 'iobType') && !Object.prototype.hasOwnProperty.call(deviceTypes[id], 'isArray')) {

						// first check if this feature is available for device
						if (!await this.featureCheck(id, channel, deviceTypes, objOrg, 'state')) continue;

						// if we have a 'iobType' property, then it's a state
						let stateId = id;

						if (Object.prototype.hasOwnProperty.call(deviceTypes[id], 'id')) {
							// if we have a custom state, use defined id
							stateId = deviceTypes[id].id;
						}

						logMsgState = '.' + `${channel}.${stateId}`.split('.')?.slice(1)?.join('.');

						if (!this.blacklistedStates.includes(`${filterComparisonId}.${id}`)) {
							// not on blacklist

							if (!await this.objectExists(`${channel}.${stateId}`)) {
								// create State
								this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - creating state '${logMsgState}'`);
								const obj = {
									type: 'state',
									common: await this.getCommonGenericState(id, deviceTypes, objOrg, logMsgState),
									native: {}
								};

								// @ts-ignore
								await this.setObjectAsync(`${channel}.${stateId}`, obj);
							} else {
								// update State if needed
								const obj = await this.getObjectAsync(`${channel}.${stateId}`);

								const commonUpdated = await this.getCommonGenericState(id, deviceTypes, objOrg, logMsgState);

								if (obj && obj.common) {
									//@ts-ignore
									if (!myHelper.isStateCommonEqual(obj.common, commonUpdated)) {
										await this.extendObject(`${channel}.${stateId}`, { common: commonUpdated });
										this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - updated common properties of state '${logMsgState}'`);
									}
								}
							}

							if (deviceTypes[id].write && deviceTypes[id].write === true) {
								// state is writeable -> subscribe it
								this.log.silly(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - subscribing state '${logMsgState}'`);
								await this.subscribeStatesAsync(`${channel}.${stateId}`);
							}

							if (objValues && Object.prototype.hasOwnProperty.call(objValues, id)) {
								// write current val to state
								if (deviceTypes[id].readVal) {
									await this.setStateChangedAsync(`${channel}.${stateId}`, deviceTypes[id].readVal(objValues[id]), true);
								} else {
									await this.setStateChangedAsync(`${channel}.${stateId}`, objValues[id], true);
								}
							} else {
								if (!Object.prototype.hasOwnProperty.call(deviceTypes[id], 'id')) {
									// only report it if it's not a custom defined state
									this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - property '${logMsgState}' not exists in bootstrap values (sometimes this option may first need to be activated / used in the Unifi Protect application or will update by an event)`);
								}
							}
						} else {
							// is on blacklist
							if (await this.objectExists(`${channel}.${stateId}`)) {
								this.log.info(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - deleting blacklisted state '${logMsgState}'`);
								await this.delObjectAsync(`${channel}.${stateId}`);
							} else {
								this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - skip creating state '${logMsgState}', because it is on blacklist`);
							}
						}
					} else {
						if (!this.blacklistedStates.includes(`${filterComparisonId}.${id}`)) {
							if (id !== 'hasFeature' && id !== 'name') {
								// it's a channel, create it and iterate again over the properties

								// first check if this feature is available for device
								if (!await this.featureCheck(id, channel, deviceTypes, objOrg, 'channel')) continue;

								const common = {
									name: Object.prototype.hasOwnProperty.call(deviceTypes[id], 'name') ? deviceTypes[id].name : id
								};

								if (!await this.objectExists(`${channel}.${id}`)) {
									// create channel
									this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - creating channel '${logMsgState}'`);

									await this.setObjectAsync(`${channel}.${id}`, {
										type: 'channel',
										common: common,
										native: {}
									});
								} else {
									// check if common of channel has updates
									const obj = await this.getObjectAsync(`${channel}.${id}`);

									if (obj && obj.common) {
										//@ts-ignore
										if (!myHelper.isChannelCommonEqual(obj.common, common)) {
											await this.extendObject(`${channel}.${id}`, { common: common });
											this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - channel updated '${logMsgState}'`);
										}
									}
								}

								if (objValues[id] && objValues[id].constructor.name === 'Array' && Object.prototype.hasOwnProperty.call(deviceTypes[id], 'isArray')) {
									for (let i = 0; i <= objValues[id].length - 1; i++) {
										await this.createGenericState(`${channel}.${id}.${i}`, deviceTypes[id].items, objValues[id][i], `${filterComparisonId}.${id}`, objOrg);
									}
								} else {
									await this.createGenericState(`${channel}.${id}`, deviceTypes[id], objValues[id], `${filterComparisonId}.${id}`, objOrg);
								}
							}
						} else {
							if (await this.objectExists(`${channel}.${id}`)) {
								this.log.info(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - deleting blacklisted channel '${logMsgState}'`);
								await this.delObjectAsync(`${channel}.${id}`, { recursive: true });
							} else {
								this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - skip creating channel '${logMsgState}', because it is on blacklist`);
							}
						}
					}
				} catch (error) {
					this.log.error(`${logPrefix} [id: ${id}] error: ${error}, stack: ${error.stack}`);
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	async getCommonGenericState(id, deviceTypes, objOrg, logMsgState) {
		const logPrefix = '[getCommonGenericState]:';

		try {
			const common = {
				name: deviceTypes[id].name ? deviceTypes[id].name : id,
				type: deviceTypes[id].iobType,
				read: deviceTypes[id].read ? deviceTypes[id].read : true,
				write: deviceTypes[id].write ? deviceTypes[id].write : false,
				role: deviceTypes[id].role ? deviceTypes[id].role : 'state',
			};

			if (deviceTypes[id].unit) common.unit = deviceTypes[id].unit;

			if (deviceTypes[id].min || deviceTypes[id].min === 0) common.min = deviceTypes[id].min;

			if (deviceTypes[id].max || deviceTypes[id].max === 0) common.max = deviceTypes[id].max;

			if (deviceTypes[id].step) common.step = deviceTypes[id].step;


			if (deviceTypes[id].states) {
				common.states = deviceTypes[id].states;
			} else if (Object.prototype.hasOwnProperty.call(deviceTypes[id], 'statesFromProperty')) {
				const statesFromProp = myHelper.getAllowedCommonStates(deviceTypes[id].statesFromProperty, objOrg);

				common.states = statesFromProp;
				this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - set allowed common.states for '${logMsgState}' (from: ${deviceTypes[id].statesFromProperty})`);
			}

			if (deviceTypes[id].desc) common.desc = deviceTypes[id].desc;

			return common;
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	async featureCheck(id, channel, deviceTypes, objOrg, stateType) {
		const logPrefix = '[featureCheck]:';

		try {
			if (deviceTypes[id].hasFeature) {
				// if we have a 'hasFeature' property, then it's a state
				let stateId = id;

				if (Object.prototype.hasOwnProperty.call(deviceTypes[id], 'id')) {
					// if we have a custom state, use defined id
					stateId = deviceTypes[id].id;
				}
				const logMsgState = '.' + `${channel}.${stateId}`.split('.')?.slice(1)?.join('.');
				let hasFeature = true;

				if (deviceTypes[id].hasFeature.startsWith('nvr.')) {
					// feature check must be done on NVR
					hasFeature = myHelper.getObjectByString(deviceTypes[id].hasFeature.replace('nvr.', ''), this.devices.nvr);
				} else {
					// feature check must be done on device it self
					hasFeature = myHelper.getObjectByString(deviceTypes[id].hasFeature, objOrg);
				}

				if (!hasFeature) {
					if (await this.objectExists(`${channel}.${stateId}`)) {
						this.log.info(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - deleting ${stateType} '${logMsgState}', because feature is not available for this device`);
						await this.delObjectAsync(`${channel}.${stateId}`, { recursive: true });
					} else {
						this.log.debug(`${logPrefix} ${this.ufp?.getDeviceName(objOrg)} - skip creating ${stateType} '${logMsgState}', because feature is not available for this device`);
					}
					return false;
				}
			}

			return true;
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Update device values from event payload
	 * @param {any} idDevice id of device (e.g. camera id)
	 * @param {string | undefined} idParentDevice id of parent device (e.g. cameras)
	 * @param {object} deviceTypes defined states and types in {@link myDeviceTypes}
	 * @param {object} payload data from event
	 */
	async updateStates(idDevice, idParentDevice, device, deviceTypes, payload, idPrefix = '') {
		const logPrefix = '[updateStates]:';

		try {
			for (const key in payload) {
				if (deviceTypes[key]) {
					if (Object.prototype.hasOwnProperty.call(deviceTypes[key], 'iobType')) {
						const id = `${idParentDevice ? `${idParentDevice}.` : ''}${idDevice}${idPrefix}.${key}`;
						const val = deviceTypes[key].readVal ? deviceTypes[key].readVal(payload[key]) : payload[key];

						if (this.log.level === 'silly') {
							const oldState = await this.getStateAsync(id);

							if (oldState && oldState.val !== val) {
								this.log.silly(`${logPrefix} ${this.ufp?.getDeviceName(device)} - update state '.${idDevice}${idPrefix}.${key}': ${val} (oldVal: ${oldState.val})`);
							}
						}

						if (await this.objectExists(id)) // check, as id may be on blacklist
							await this.setStateChangedAsync(id, val, true);
					} else {
						await this.updateStates(idDevice, idParentDevice, device, deviceTypes[key], payload[key], `${idPrefix}.${key}`);
					}
				}
			}

		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	async retentionManager() {
		const logPrefix = '[retentionManager]:';

		try {
			this.log.debug(`${logPrefix} retention check starting...`);
			if (this.config.manualSnapshotRetention > 0) {
				let dirList = null;

				try {
					dirList = await this.readDirAsync(this.namespace, this.storagePaths.snapshotCameras);

					// eslint-disable-next-line no-unused-vars
				} catch (ignore) {
					// no dir's found -> ignore
				}

				if (dirList !== null) {
					for (const dir of dirList) {
						if (dir.isDir) {
							let dirCams = null;

							try {
								dirCams = await this.readDirAsync(this.namespace, `${this.storagePaths.snapshotCameras}${dir.file}/`);

								// eslint-disable-next-line no-unused-vars
							} catch (ignore) {
								// no dir's found -> ignore
							}

							if (dirCams !== null) {
								for (const file of dirCams) {
									const diff = moment().diff(moment(file.file, this.fileNameFormat), 'minutes');

									if (diff / 1440 >= this.config.manualSnapshotRetention) {
										const fileName = `${this.storagePaths.snapshotCameras}${dir.file}/${file.file}`;
										this.delFileAsync(this.namespace, fileName);
										this.log.info(`${logPrefix} snapshot '${fileName}' deleted, because it's ${(diff / 1440).toFixed(2)} days old`);
									}
								}
							}
						}
					}
				}
			}

			if (this.config.motionEventsHistoryEnabled && this.config.motionEventsHistoryRetention > 0) {
				const eventChannels = await this.getStatesAsync('events.motion.*.start');

				for (const id in eventChannels) {
					if (eventChannels[id] && eventChannels[id].val) {
						const diff = moment().diff(moment(eventChannels[id].val), 'minutes');

						if (diff / 60 > this.config.motionEventsHistoryRetention) {
							await this.delObjectAsync(myHelper.getIdWithoutLastPart(id), { recursive: true });
							this.log.info(`${logPrefix} motion event '${myHelper.getIdWithoutLastPart(id)}' deleted, because it's ${(diff / 60).toFixed(2)} hours old`);
						}
					}
				}
			}

			if (this.retentionTimeout) {
				this.clearTimeout(this.retentionTimeout);
				this.retentionTimeout = null;
			}

			this.retentionTimeout = this.setTimeout(() => {
				this.retentionManager();
			}, 60 * 60 * 1000);
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** create list of all states for adapter config (sendTo from frontend)
	 * @param {object} deviceTypes defined states and types in {@link myDeviceTypes}
	 * @param {string} idPrefix
	 */
	async createConfigFilterList(deviceTypes, idPrefix = '') {
		const logPrefix = '[createConfigFilterList]:';

		try {
			for (const key in deviceTypes) {

				if (key && Object.prototype.hasOwnProperty.call(deviceTypes[key], 'iobType')) {
					// if we have a 'type' property, then it's a state
					let stateId = key;

					if (Object.prototype.hasOwnProperty.call(deviceTypes[key], 'id')) {
						// if we have a custom state, use defined id
						stateId = deviceTypes[key].id;
					}

					this.configFilterList.push({
						label: `[State]\t\t ${idPrefix}${stateId}`,
						value: `${idPrefix}${key}`,
					});
				} else {
					if (key !== 'hasFeature' && key !== 'name') {
						if (!this.configFilterListIgnore.includes(key)) {
							this.configFilterList.push({
								label: `[Channel]\t ${idPrefix}${key}`,
								value: `${idPrefix}${key}`,
							});
						}

						await this.createConfigFilterList(deviceTypes[key], `${idPrefix}${key}.`);
					}
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** transform adapter config blacklisted states into to an array
	 */
	async prepareBlacklistedStates() {
		const logPrefix = '[prepareBlacklistedStates]:';

		try {
			for (const key in this.config.blacklistedStates) {
				if (this.config.blacklistedStates[key]) {
					this.blacklistedStates.push(this.config.blacklistedStates[key].id);
				}
			}
			this.log.debug(`${logPrefix} blacklist states: ${JSON.stringify(this.blacklistedStates)}`);
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** Set adapter info.connection state and internal var
	 * @param {boolean} isConnected
	 */
	async setConnectionStatus(isConnected, isThrottled) {
		const logPrefix = '[setConnectionStatus]:';

		try {
			this.isConnected = isConnected;
			await this.setStateAsync('info.connection', isConnected, true);
			await this.setStateAsync('info.isThrottled', isThrottled, true);

			if (isThrottled) {
				this.log.warn(`${logPrefix} connection is throttled!`);
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}


	/** settings values for all states that are available in eventStore
	 * @param {string} channelId
	 * @param {import("unifi-protect", { with: { "resolution-mode": "import" } }).ProtectKnownDeviceTypes} cam
	 * @param {object} eventStoreObj
	 */
	async setCustomMotionEventStates(channelId, cam, eventStoreObj, onlyChanges = false, isHistory = false) {
		const logPrefix = '[setCustomMotionEventStates]:';

		try {
			if (isHistory) {
				// create Channel for motion event history
				const idChannel = `${channelId}.${eventStoreObj.lastMotionEventId}`;

				if (!await this.objectExists(idChannel)) {
					await this.setObjectAsync(idChannel, {
						type: 'channel',
						common: {
							name: cam.name,
							desc: `→ ${this.namespace}.cameras.${cam.mac}`
						},
						native: {}
					});

					// add addtional information to event, so that states for this can be created
					eventStoreObj.name = cam.name;
					eventStoreObj.mac = cam.mac;

					this.log.silly(`${logPrefix} ${eventStoreObj.lastMotionEventId} - creating channel for event '.${idChannel}'`);
				}
			}

			for (const key in eventStoreObj) {
				if (Object.prototype.hasOwnProperty.call(myDeviceTypes.cameras, key)) {

					const val = myDeviceTypes.cameras[key].readVal ? myDeviceTypes.cameras[key].readVal(eventStoreObj[key]) : eventStoreObj[key];

					if (isHistory) {
						const id = `${channelId}.${eventStoreObj.lastMotionEventId}.${(myDeviceTypes.cameras[key].id || key).replace('lastMotion.', '')}`;
						const logMsgState = `.${id}`;

						if (!await this.objectExists(id)) {
							const obj = {
								type: 'state',
								common: await this.getCommonGenericState(key, myDeviceTypes.cameras, cam, logMsgState),
								native: {}
							};

							// @ts-ignore
							await this.setObjectAsync(id, obj);

							this.log.silly(`${logPrefix} ${eventStoreObj.lastMotionEventId} - create state for event '.${id}': ${val}`);
						}

						await this.setStateExists(id, val, onlyChanges);
						this.log.silly(`${logPrefix} - ${eventStoreObj.lastMotionEventId} - update event state '${id}': ${val}`);
					} else {
						const id = `${channelId}.${cam.mac}.${myDeviceTypes.cameras[key].id}`;

						await this.setStateExists(id, val, onlyChanges);
						this.log.silly(`${logPrefix} ${this.ufp?.getDeviceName(cam)}, eventId: ${eventStoreObj.lastMotionEventId} - update state '${id}': ${val}`);
					}
				}
			}
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** check if state exists before setting value
	 * @param {string} id
	 * @param {any} val
	 */
	async setStateExists(id, val, onlyChanges = false) {
		const logPrefix = '[setThumbState]:';

		try {
			if (await this.objectExists(id)) {
				if (!onlyChanges) {
					await this.setStateAsync(id, val, true);
				} else {
					await this.setStateChangedAsync(id, val, true);
				}
			}

		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** set default images for snapshot, thumbnail and thumbnailAnimated - will be shown if no image is available / loading
	 */
	async setDefaultImages() {
		const logPrefix = '[setDefaultImages]:';

		try {
			this.defaultImage.snapshot = await this.loadDefaultImage('defaultSnapshot.png');
			this.defaultImage.thumbnail = await this.loadDefaultImage('defaultThumbnail.png');
			this.defaultImage.thumbnailAnimated = await this.loadDefaultImage('defaultThumbnailAnimated.png');
		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}
	}

	/** copy default images to instance folder (e.g. /unifi-protect-nvr.0/) if not exists and load them
	 * @param {string} fileName
	 * @returns base64 image string
	 */
	async loadDefaultImage(fileName) {
		const logPrefix = '[loadDefaultImage]:';

		try {
			if (!await this.fileExistsAsync(this.namespace, fileName)) {
				const logoFile = fs.readFileSync('./admin/unifi-protect-nvr.png');
				await this.writeFileAsync(this.namespace, fileName, logoFile);
			}

			const img = await this.readFileAsync(this.namespace, fileName);

			const imageBuffer = Buffer.from(img.file);
			const imageBase64 = imageBuffer.toString('base64');
			const base64ImgString = `data:image/png;base64,` + imageBase64;

			this.log.debug(`${logPrefix} default image '${fileName}' loaded`);

			return base64ImgString;

		} catch (error) {
			this.log.error(`${logPrefix} error: ${error}, stack: ${error.stack}`);
		}

		return '';
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