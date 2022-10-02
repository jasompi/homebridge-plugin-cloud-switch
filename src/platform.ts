import { API, APIEvent, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { SwitchAccessory, SwitchConfig } from './platformAccessory';
import { CloudSwitch } from 'cloud-switch-js';

export interface CloudSwitchPlatformConfig extends PlatformConfig {
  accessToken: string;
  deviceId: string;
  excludedSwitches: string;
}

export class CloudSwitchHomebridgePlatform implements DynamicPlatformPlugin {
  // this is used to track restored cached accessories
  private readonly accessories: PlatformAccessory[] = [];
  // switch published to HomeKit
  private switchAccessories: (SwitchAccessory | undefined)[] = [];
  private readonly config: CloudSwitchPlatformConfig;
  // Switch indexes to be excluded. (Not published to HomeKit)
  private readonly excludedSwitches: Set<number>;
  private cloudSwitch: CloudSwitch | null = null;
  private switchConfigTimestamp = 0;

  constructor(
    private readonly log: Logger,
    config: PlatformConfig,
    private readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', config.name);
    this.config = config as CloudSwitchPlatformConfig;
    if (this.config.excludedSwitches) {
      this.excludedSwitches = new Set(this.config.excludedSwitches.split(',').map((index: string) => Number(index)));
    } else {
      this.excludedSwitches = new Set();
    }
    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, () => {
      log.debug('CloudSwitch didFinishLaunching');
      // run the method to discover / register your devices as accessories
      this.discoverDevices().then(() => log.debug('discoverDevices completed')).catch((error) => {
        log.error('discoverDevices failed', error);
        if (error instanceof this.api.hap.HapStatusError) {
          throw error;
        }
        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      });
    });

    this.api.on(APIEvent.SHUTDOWN, () => {
      this.log.info('CloudSwitch shutdown');
      this.cloudSwitch?.onSwitchConfigChanged(undefined);
      this.cloudSwitch?.onSwitchStateChanged(undefined);
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  async discoverDevices(): Promise<void> {
    const config = this.config as CloudSwitchPlatformConfig;
    this.cloudSwitch = await CloudSwitch.createCloudSwitchForId(config.deviceId, config.accessToken);

    if (!this.cloudSwitch.isOnline()) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    this.cloudSwitch.onSwitchConfigChanged((timestamp) => {
      if (timestamp > this.switchConfigTimestamp) {
        this.log.info(`switchConfigChanged to ${timestamp}`);
        this.setupAccessaries().catch((reason) => {
          this.log.error(`Failed to setupAccessary for updated switchConfig ${timestamp}, reason:`, reason);
        });
      }
    });
    await this.cloudSwitch.onSwitchStateChanged(this.switchStateUpdated.bind(this));
    await this.setupAccessaries();
  }

  async setupAccessaries(): Promise<void> {
    if (this.cloudSwitch === undefined) {
      this.log.error('Cloud Switch is not setup');
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    const switchConfig = await this.cloudSwitch!.getSwitchConfig();
    if (!(switchConfig.names instanceof Array) || !(switchConfig.codes instanceof Array)) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST);
    }

    const switchStates = await this.cloudSwitch!.switchStates();

    const newAccessaries: PlatformAccessory[] = [];
    const existingAccessaries: PlatformAccessory[] = [];
    for (let i = 0; i < switchConfig.names.length; i++) {
      const name = switchConfig.names[i];
      if (switchConfig.codes[i].length <= 0 || this.excludedSwitches.has(i)) {
        this.log.debug(`Skip switch ${name}`);
        this.switchAccessories[i] = undefined;
      } else {
        // generate a unique id for the accessory this should be generated from
        // something globally unique, but constant, for example, the device serial
        // number or MAC address
        const sericalNumber = `${this.cloudSwitch!.id()}:${i}`;
        const uuid = this.api.hap.uuid.generate(sericalNumber);

        let accessory = this.accessories.find(accessory => accessory.UUID === uuid);
        if (accessory) {
          this.log.info(`Restoring existing accessory from cache: ${name}(${sericalNumber}) uuid: ${uuid}`);
          accessory.displayName = name;
          existingAccessaries.push(accessory);
        } else {
          // the accessory does not yet exist, so we need to create it
          this.log.info(`Adding new accessory: ${name}(${sericalNumber}) uuid: ${uuid}`);

          // create a new accessory
          accessory = new this.api.platformAccessory(name, uuid);
          newAccessaries.push(accessory);
        }

        const switchConfig: SwitchConfig = {
          log: this.log,
          name,
          manufacture: 'JPi Mobile',
          model: 'CS-2022',
          sericalNumber,
          initialState: switchStates[i],
          turnOn: this.turnOnSwitch.bind(this, i),
          turnOff: this.turnOffSwitch.bind(this, i),
        };

        // store a copy of the device object in the `accessory.context`
        // the `context` property can be used to store any data about the accessory you may need
        accessory.context = switchConfig;

        // create the accessory handler for the newly create accessory
        // this is imported from `platformAccessory.ts`
        this.switchAccessories[i] = new SwitchAccessory(this.api, accessory);
      }
    }
    this.log.debug('original ', this.accessories.map(acc => `${acc.displayName}(${acc.UUID})`));

    // Unregiester accessaries
    const accessories = this.accessories.filter(acc => !existingAccessaries.includes(acc));
    this.log.debug('unregister ', accessories.map(acc => `${acc.displayName}(${acc.UUID})`));
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);

    this.accessories.length = 0;
    // Update cached accessories
    this.log.debug('update ', existingAccessaries.map(acc => `${acc.displayName}(${acc.UUID})`));
    this.api.updatePlatformAccessories(existingAccessaries);
    this.accessories.push(...existingAccessaries);

    this.log.debug('register ', newAccessaries.map(acc => `${acc.displayName}(${acc.UUID})`));
    // Register new accessory to your platform
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, newAccessaries);
    this.accessories.push(...newAccessaries);

    this.log.debug('new ', this.accessories.map(acc => `${acc.displayName}(${acc.UUID})`));

    this.switchConfigTimestamp = switchConfig.timestamp;
  }

  async switchStateUpdated(switchIndex: number, state: boolean) {
    if (this.switchAccessories[switchIndex] !== undefined) {
      this.switchAccessories[switchIndex]!.updateState(state);
    }
  }

  async turnOnSwitch(switchIndex: number): Promise<boolean> {
    if (this.cloudSwitch === undefined) {
      this.log.error('Cloud Switch is not setup');
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    if (this.switchAccessories[switchIndex] === undefined) {
      this.log.error(`SwithIndex ${switchIndex} is not valid`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    return await this.cloudSwitch!.turnOnSwitch(switchIndex);
  }

  async turnOffSwitch(switchIndex: number): Promise<boolean> {
    if (this.cloudSwitch === undefined) {
      this.log.error('Cloud Switch is not setup');
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
    if (this.switchAccessories[switchIndex] === undefined) {
      this.log.error(`SwithIndex ${switchIndex} is not valid`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    }
    return await this.cloudSwitch!.turnOffSwitch(switchIndex);
  }

}
