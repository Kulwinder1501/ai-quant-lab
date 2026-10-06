declare module "fyers-api-v3" {
  export const fyersDataSocket: {
    getInstance: (auth: string, logPath: string, enableLogging?: boolean) => any;
  };
  export const fyersModel: any;
  export const fyersOrderSocket: any;
  export const fyersTbtSocket: any;
}
