/**
 * A colour per member (item 3 direction B): the avatar's fill, as Outlook and Teams
 * colour people. Derived from the username, so it needs no stored value and is the same on every
 * device. The set avoids red and green (money) and gold (the mark); each holds white initials at
 * >=4.5:1.
 */
const MEMBER_COLOURS = ['#6b4fd8', '#0f7c86', '#b0357a', '#2a6fc9', '#8a4fb0', '#9a5b1e', '#4a5bb8', '#00788a'];

export function memberColour(username: string): string {
	let h = 0;
	for (const ch of username.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
	return MEMBER_COLOURS[h % MEMBER_COLOURS.length]!;
}
