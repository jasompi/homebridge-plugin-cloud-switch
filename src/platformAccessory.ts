import { API, Service, PlatformAccessory, CharacteristicValue, Logger } from 'homebridge';


export interface SwitchConfig {
  readonly log: Logger;
  readonly name: string;
  readonly manufacture: string;
  readonly model: string;
  readonly sericalNumber: string;
  readonly initialState: boolean;
  readonly turnOn: () => Promise<boolean>;
  readonly turnOff: () => Promise<boolean>;
}

export class SwitchAccessory {
  private service: Service;
  private config: SwitchConfig;
  private state: boolean;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
  ) {
    this.config = accessory.context as SwitchConfig;
    // set accessory information
    this.accessory.getService(this.api.hap.Service.AccessoryInformation)!
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, this.config.manufacture)
      .setCharacteristic(this.api.hap.Characteristic.Model, this.config.model)
      .setCharacteristic(this.api.hap.Characteristic.SerialNumber, this.config.sericalNumber);

    // set the initial state
    this.state = this.config.initialState;

    // get the Switch service if it exists, otherwise create a new Switch service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.api.hap.Service.Switch) || this.accessory.addService(this.api.hap.Service.Switch);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.api.hap.Characteristic.Name, this.config.name);

    // register handlers for the On/Off Characteristic
    this.service.getCharacteristic(this.api.hap.Characteristic.On)
      .onSet(this.setOn.bind(this))                // SET - bind to the `setOn` method below
      .onGet(this.getOn.bind(this));               // GET - bind to the `getOn` method below
  }

  /**
   * Update switch state when receive push notification.
   * @param isOn new switch state
   */
  public updateState(isOn: boolean) {
    if (this.state !== isOn) {
      this.state = isOn;
      this.service.updateCharacteristic(this.api.hap.Characteristic.On, isOn);
      this.config.log.debug(`switch ${this.config.name} change to ${isOn ? 'On' : 'Off'}`);
    }
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, turning on a Light bulb.
   */
  async setOn(value: CharacteristicValue) {
    const isOn = value as boolean;
    try {
      this.state = isOn ? await this.config.turnOn() : await this.config.turnOff();
      this.config.log.debug(`Switch ${this.config.name} set to ${isOn ? 'On' : 'Off'} result ${this.state ? 'On' : 'Off'}`);
    } catch (error) {
      this.config.log.error(`Switch ${this.config.name} failed to set to ${isOn ? 'On' : 'Off'} error:`, error);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possbile. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  async getOn(): Promise<CharacteristicValue> {
    this.config.log.debug(`Switch ${this.config.name} is ${this.state ? 'On' : 'Off'}`);
    return this.state;
  }

}
