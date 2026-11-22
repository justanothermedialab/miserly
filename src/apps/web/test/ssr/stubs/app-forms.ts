// $app/forms for the ssr project: `enhance` is an action, and actions never run on the server.
export const enhance = () => ({ destroy() {} });
export const applyAction = async () => {};
export const deserialize = (s: string) => JSON.parse(s);
