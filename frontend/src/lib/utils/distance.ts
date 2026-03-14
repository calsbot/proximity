export function formatDistance(meters?: number | null): string {
	if (!meters) return '';
	if (meters < 250) return '< 250m';
	if (meters < 500) return '< 500m';
	if (meters < 1000) return '< 1km';
	if (meters < 2000) return '~1km';
	if (meters < 5000) return '~' + Math.round(meters / 1000) + 'km';
	return '~' + Math.round(meters / 1000) + 'km';
}