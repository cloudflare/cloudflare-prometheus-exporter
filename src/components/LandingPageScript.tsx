import { html } from "hono/html";
import type { FC } from "hono/jsx";

type Props = { metricsPath: string; disableConfigApi: boolean };

export const LandingPageScript: FC<Props> = ({ metricsPath, disableConfigApi }) => {
	return html`
		<script>
			// Config API disabled flag
			const configApiDisabled = ${String(disableConfigApi)};

			// Config state management
			let serverConfig = {};
			let localConfig = {};
			let defaultConfig = {};
			let dirtyFields = new Set();

			// Config field definitions
			const configFields = [
				'queryLimit', 'scrapeDelaySeconds', 'timeWindowSeconds', 'metricRefreshIntervalSeconds',
				'accountListCacheTtlSeconds', 'zoneListCacheTtlSeconds', 'sslCertsCacheTtlSeconds',
				'logLevel', 'logFormat', 'cfAccounts', 'cfZones', 'cfFreeTierAccounts', 'metricsDenylist',
				'excludeHost', 'httpStatusGroup'
			];

			// Load config on page load
			async function loadConfig() {
				if (configApiDisabled) return;
				try {
					const [configRes, defaultsRes] = await Promise.all([
						fetch('/config'),
						fetch('/config/defaults')
					]);
					if (!configRes.ok) throw new Error('Failed to load config');
					if (!defaultsRes.ok) throw new Error('Failed to load defaults');
					serverConfig = await configRes.json();
					defaultConfig = await defaultsRes.json();
					localConfig = { ...serverConfig };
					dirtyFields.clear();
					populateForm();
					updateSaveButton();
				} catch (e) {
					console.error('Failed to load config:', e);
					document.getElementById('config-status').textContent = 'Failed to load configuration';
				}
			}

			// Populate form fields from config
			function populateForm() {
				// Number fields
				['queryLimit', 'scrapeDelaySeconds', 'timeWindowSeconds', 'metricRefreshIntervalSeconds',
				 'accountListCacheTtlSeconds', 'zoneListCacheTtlSeconds', 'sslCertsCacheTtlSeconds'].forEach(key => {
					const el = document.getElementById('cfg-' + key);
					if (el) el.value = localConfig[key] ?? '';
				});

				// Select fields
				['logLevel', 'logFormat'].forEach(key => {
					const el = document.getElementById('cfg-' + key);
					if (el) el.value = localConfig[key] ?? '';
				});

				// Text fields (nullable)
				['cfAccounts', 'cfZones'].forEach(key => {
					const el = document.getElementById('cfg-' + key);
					const allCheckbox = document.getElementById('cfg-' + key + '-all');
					if (el && allCheckbox) {
						const isAll = localConfig[key] === null;
						allCheckbox.checked = isAll;
						el.value = isAll ? '' : (localConfig[key] ?? '');
						el.disabled = isAll;
					}
				});

				// Text fields (non-nullable)
				['cfFreeTierAccounts', 'metricsDenylist'].forEach(key => {
					const el = document.getElementById('cfg-' + key);
					if (el) el.value = localConfig[key] ?? '';
				});

				// Toggle switches
				['excludeHost', 'httpStatusGroup'].forEach(key => {
					const el = document.getElementById('cfg-' + key);
					if (el) {
						const isActive = localConfig[key] === true;
						el.classList.toggle('active', isActive);
						el.setAttribute('aria-checked', isActive.toString());
					}
				});
			}

			// Track field changes
			function onFieldChange(key, value) {
				localConfig[key] = value;
				if (JSON.stringify(value) !== JSON.stringify(serverConfig[key])) {
					dirtyFields.add(key);
				} else {
					dirtyFields.delete(key);
				}
				updateSaveButton();
			}

			// Toggle for "All accounts/zones" checkboxes
			function toggleAllFilter(key, isAll) {
				const el = document.getElementById('cfg-' + key);
				if (el) {
					el.disabled = isAll;
					if (isAll) {
						el.value = '';
						onFieldChange(key, null);
					} else {
						onFieldChange(key, el.value || null);
					}
				}
			}

			// Toggle switch handler
			function toggleSwitch(key) {
				const el = document.getElementById('cfg-' + key);
				if (el) {
					const newValue = !el.classList.contains('active');
					el.classList.toggle('active', newValue);
					el.setAttribute('aria-checked', newValue.toString());
					onFieldChange(key, newValue);
				}
			}

			// Save all dirty fields
			async function saveConfig() {
				const btn = document.getElementById('save-btn');
				btn.disabled = true;
				btn.textContent = 'Saving...';

				const errors = [];
				for (const key of dirtyFields) {
					try {
						const res = await fetch('/config/' + key, {
							method: 'PUT',
							headers: { 'Content-Type': 'application/json' },
							body: JSON.stringify({ value: localConfig[key] })
						});
						if (!res.ok) {
							const data = await res.json();
							errors.push({ key, error: data.error || 'Unknown error' });
						}
					} catch (e) {
						errors.push({ key, error: e.message });
					}
				}

				if (errors.length === 0) {
					serverConfig = { ...localConfig };
					dirtyFields.clear();
					showToast('Configuration saved', 'success');
				} else {
					showToast('Failed to save: ' + errors.map(e => e.key).join(', '), 'error');
				}

				btn.textContent = 'Save Changes';
				updateSaveButton();
			}

			// Reset single field to default (updates UI only, requires Save to persist)
			function resetField(key) {
				const defaultValue = defaultConfig[key];
				localConfig[key] = defaultValue;
				if (JSON.stringify(defaultValue) !== JSON.stringify(serverConfig[key])) {
					dirtyFields.add(key);
				} else {
					dirtyFields.delete(key);
				}
				updateFieldUI(key);
				updateSaveButton();
			}

			// Reset all config to defaults (updates UI only, requires Save to persist)
			function resetAllConfig() {
				if (!confirm('Reset all configuration to defaults?')) return;
				localConfig = { ...defaultConfig };
				dirtyFields.clear();
				for (const key of configFields) {
					if (JSON.stringify(defaultConfig[key]) !== JSON.stringify(serverConfig[key])) {
						dirtyFields.add(key);
					}
				}
				populateForm();
				updateSaveButton();
			}

			// Update single field UI
			function updateFieldUI(key) {
				const el = document.getElementById('cfg-' + key);
				if (!el) return;

				if (['excludeHost', 'httpStatusGroup'].includes(key)) {
					const isActive = localConfig[key] === true;
					el.classList.toggle('active', isActive);
					el.setAttribute('aria-checked', isActive.toString());
				} else if (['cfAccounts', 'cfZones'].includes(key)) {
					const allCheckbox = document.getElementById('cfg-' + key + '-all');
					const isAll = localConfig[key] === null;
					if (allCheckbox) allCheckbox.checked = isAll;
					el.disabled = isAll;
					el.value = isAll ? '' : (localConfig[key] ?? '');
				} else {
					el.value = localConfig[key] ?? '';
				}
			}

			// Update save button state
			function updateSaveButton() {
				const btn = document.getElementById('save-btn');
				const status = document.getElementById('config-status');
				btn.disabled = dirtyFields.size === 0;
				if (dirtyFields.size > 0) {
					status.textContent = dirtyFields.size + ' unsaved change' + (dirtyFields.size > 1 ? 's' : '');
				} else {
					status.textContent = 'All changes saved';
				}
			}

			// Tab switching
			function switchTab(tabId) {
				document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
				document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.add('hidden'));
				document.querySelector('[data-tab="' + tabId + '"]').classList.add('active');
				document.getElementById('tab-' + tabId).classList.remove('hidden');
			}

			// Toast notification
			function showToast(message, type) {
				const toast = document.getElementById('toast');
				toast.textContent = message;
				toast.className = 'toast ' + type + ' show';
				setTimeout(() => {
					toast.classList.remove('show');
				}, 3000);
			}

			async function checkHealth() {
				const indicator = document.getElementById('health-indicator');
				const status = document.getElementById('health-status');
				const badge = document.getElementById('health-badge');
				const cfApiIndicator = document.getElementById('cf-api-indicator');
				const cfApiLatency = document.getElementById('cf-api-latency');
				const cfApiError = document.getElementById('cf-api-error');
				const gqlApiIndicator = document.getElementById('gql-api-indicator');
				const gqlApiLatency = document.getElementById('gql-api-latency');
				const gqlApiError = document.getElementById('gql-api-error');
				const healthTimestamp = document.getElementById('health-timestamp');

				const setCheckStatus = (indicatorEl, latencyEl, errorEl, check) => {
					if (check.status === 'healthy') {
						indicatorEl.className = 'w-2 h-2 rounded-full bg-green-500';
						latencyEl.className = 'text-xs font-mono text-green-600';
						latencyEl.textContent = check.latency_ms + 'ms';
						errorEl.classList.add('hidden');
						errorEl.textContent = '';
					} else {
						indicatorEl.className = 'w-2 h-2 rounded-full bg-red-500';
						latencyEl.className = 'text-xs font-mono text-red-600';
						latencyEl.textContent = check.latency_ms + 'ms';
						if (check.error) {
							errorEl.textContent = check.error;
							errorEl.classList.remove('hidden');
						} else {
							errorEl.classList.add('hidden');
						}
					}
				};

				try {
					const res = await fetch('/health');
					const data = await res.json();

					setCheckStatus(cfApiIndicator, cfApiLatency, cfApiError, data.checks.cloudflare_api);
					setCheckStatus(gqlApiIndicator, gqlApiLatency, gqlApiError, data.checks.graphql_api);

					const ts = new Date(data.timestamp);
					healthTimestamp.textContent = 'Last checked ' + ts.toLocaleTimeString();

					if (data.status === 'healthy') {
						indicator.className = 'w-3 h-3 rounded-full bg-green-500 pulse-dot';
						status.textContent = 'All systems operational';
						badge.className = 'px-4 py-2 rounded-full text-sm font-medium bg-green-500/10 text-green-600 border border-green-500/20';
						badge.textContent = 'Healthy';
					} else {
						const unhealthyChecks = [];
						if (data.checks.cloudflare_api.status !== 'healthy') unhealthyChecks.push('REST API');
						if (data.checks.graphql_api.status !== 'healthy') unhealthyChecks.push('GraphQL');
						indicator.className = 'w-3 h-3 rounded-full bg-red-500';
						status.textContent = 'Degraded: ' + unhealthyChecks.join(', ');
						badge.className = 'px-4 py-2 rounded-full text-sm font-medium bg-red-500/10 text-red-600 border border-red-500/20';
						badge.textContent = 'Unhealthy';
					}
				} catch {
					indicator.className = 'w-3 h-3 rounded-full bg-red-500';
					status.textContent = 'Unable to reach health endpoint';
					badge.className = 'px-4 py-2 rounded-full text-sm font-medium bg-red-500/10 text-red-600 border border-red-500/20';
					badge.textContent = 'Error';
					cfApiIndicator.className = 'w-2 h-2 rounded-full bg-gray-300';
					cfApiLatency.textContent = '—';
					cfApiError.classList.add('hidden');
					gqlApiIndicator.className = 'w-2 h-2 rounded-full bg-gray-300';
					gqlApiLatency.textContent = '—';
					gqlApiError.classList.add('hidden');
					healthTimestamp.textContent = 'Check failed';
				}
			}

			async function fetchMetrics() {
				const output = document.getElementById('metrics-output');
				const container = document.getElementById('metrics-container');
				const count = document.getElementById('metrics-count');
				const timestamp = document.getElementById('metrics-timestamp');
				const indicator = document.getElementById('metrics-indicator');
				const refreshIcon = document.getElementById('refresh-icon');
				indicator.className = 'w-2 h-2 rounded-full bg-gray-300';
				refreshIcon.classList.add('spin-ccw');
				const scrollTop = container.scrollTop;
				const minSpin = new Promise(r => setTimeout(r, 500));
				try {
					const [res] = await Promise.all([fetch('${metricsPath}'), minSpin]);
					if (!res.ok) {
						throw new Error('HTTP ' + res.status);
					}
					const text = await res.text();
					output.textContent = text || '# No metrics available';
					container.scrollTop = scrollTop;
					const lines = text.split('\\n').filter(l => l && !l.startsWith('#'));
					count.textContent = lines.length + ' metrics';
					timestamp.textContent = 'Updated ' + new Date().toLocaleTimeString();
					indicator.className = 'w-2 h-2 rounded-full bg-green-500 pulse-dot';
				} catch (e) {
					await minSpin;
					output.textContent = '# Error fetching metrics: ' + e.message;
					container.scrollTop = scrollTop;
					count.textContent = '-';
					timestamp.textContent = 'Failed';
					indicator.className = 'w-2 h-2 rounded-full bg-red-500';
				}
				refreshIcon.classList.remove('spin-ccw');
			}

			// Initialize on page load
			loadConfig();
			checkHealth();
			fetchMetrics();
			setInterval(checkHealth, 10000);
			setInterval(fetchMetrics, 10000);
		</script>
	`;
};
