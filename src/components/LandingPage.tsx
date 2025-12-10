import { html, raw } from "hono/html";
import type { FC } from "hono/jsx";
import type { AppConfig } from "../lib/config";
import { LandingPageScript } from "./LandingPageScript";

type Props = { config: AppConfig };

export const LandingPage: FC<Props> = ({ config }) => {
	return (
		<html lang="en">
			<head>
				<meta charset="UTF-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1.0" />
				<title>Cloudflare Prometheus Exporter</title>
				<script src="https://cdn.tailwindcss.com" />
				<link rel="preconnect" href="https://fonts.googleapis.com" />
				<link
					rel="preconnect"
					href="https://fonts.gstatic.com"
					crossorigin="anonymous"
				/>
				<link
					href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
					rel="stylesheet"
				/>
				{html`
					<script>
						tailwind.config = {
							theme: {
								extend: {
									fontFamily: {
										sans: ['Inter', 'system-ui', 'sans-serif'],
									},
								}
							}
						}
					</script>
				`}
				<style>
					{raw`.gradient-hero {
						background: linear-gradient(145deg, #f6821f 0%, #e25822 40%, #f6821f 100%);
						position: relative;
					}
					.gradient-hero::before {
						content: '';
						position: absolute;
						inset: 0;
						background-image: radial-gradient(rgba(0,0,0,0.1) 1px, transparent 1px);
						background-size: 24px 24px;
						pointer-events: none;
					}
					@keyframes pulse-dot {
						0%, 100% { opacity: 1; }
						50% { opacity: 0.5; }
					}
					.pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
					@keyframes spin-ccw {
						from { transform: rotate(0deg); }
						to { transform: rotate(-360deg); }
					}
					.spin-ccw { animation: spin-ccw 0.5s linear infinite; }
					/* Tab styles */
					.tab-btn {
						padding: 0.75rem 1rem;
						font-size: 0.875rem;
						font-weight: 500;
						color: #6b7280;
						border-bottom: 2px solid transparent;
						transition: all 0.15s ease;
						background: none;
						cursor: pointer;
					}
					.tab-btn:hover {
						color: #374151;
						border-bottom-color: #d1d5db;
					}
					.tab-btn.active {
						color: #f6821f;
						border-bottom-color: #f6821f;
					}
					.tab-panel { display: block; }
					.tab-panel.hidden { display: none; }
					/* Form input styles */
					.config-input {
						width: 100%;
						padding: 0.5rem 0.75rem;
						border-radius: 0.5rem;
						border: 1px solid #d1d5db;
						font-size: 0.875rem;
						transition: all 0.15s ease;
						outline: none;
					}
					.config-input:focus {
						border-color: #f6821f;
						box-shadow: 0 0 0 1px #f6821f;
					}
					/* Toggle switch */
					.toggle-switch {
						position: relative;
						width: 44px;
						height: 24px;
						background: #d1d5db;
						border-radius: 9999px;
						cursor: pointer;
						transition: background 0.2s ease;
					}
					.toggle-switch.active {
						background: #f6821f;
					}
					.toggle-switch::after {
						content: '';
						position: absolute;
						top: 2px;
						left: 2px;
						width: 20px;
						height: 20px;
						background: white;
						border-radius: 9999px;
						transition: transform 0.2s ease;
						box-shadow: 0 1px 3px rgba(0,0,0,0.1);
					}
					.toggle-switch.active::after {
						transform: translateX(20px);
					}
					/* Field wrapper with reset button */
					.field-wrapper {
						position: relative;
					}
					.field-reset {
						position: absolute;
						right: 0.5rem;
						top: 50%;
						transform: translateY(-50%);
						padding: 0.25rem;
						color: #9ca3af;
						cursor: pointer;
						opacity: 0;
						transition: opacity 0.15s ease;
					}
					.field-wrapper:hover .field-reset {
						opacity: 1;
					}
					.field-reset:hover {
						color: #f6821f;
					}
					/* Toast notification */
					.toast {
						position: fixed;
						bottom: 1.5rem;
						right: 1.5rem;
						padding: 0.75rem 1rem;
						border-radius: 0.5rem;
						font-size: 0.875rem;
						font-weight: 500;
						z-index: 50;
						transform: translateY(100%);
						opacity: 0;
						transition: all 0.3s ease;
					}
					.toast.show {
						transform: translateY(0);
						opacity: 1;
					}
					.toast.success {
						background: #dcfce7;
						color: #166534;
						border: 1px solid #bbf7d0;
					}
					.toast.error {
						background: #fee2e2;
						color: #991b1b;
						border: 1px solid #fecaca;
					}`}
				</style>
			</head>
			<body class="bg-[#faf8f6] font-sans antialiased min-h-screen">
				{/* Hero Section */}
				<div class="gradient-hero">
					<div class="max-w-5xl mx-auto px-6 py-16 relative z-10">
						<div class="flex items-center gap-4 mb-8">
							<svg
								aria-hidden="true"
								class="h-9 w-auto drop-shadow-md"
								viewBox="0 0 69 33"
								fill="none"
								xmlns="http://www.w3.org/2000/svg"
							>
								<path
									d="M46.7823 31.6279L47.1295 30.4071C47.551 28.962 47.3939 27.6165 46.6914 26.6365C46.0467 25.7312 44.9722 25.1997 43.6662 25.1333L18.9526 24.8177C18.7873 24.8094 18.6468 24.7346 18.5641 24.61C18.4815 24.4854 18.4567 24.3193 18.5146 24.1615C18.5972 23.9207 18.8369 23.7297 19.0849 23.7214L44.0216 23.4058C46.9807 23.2729 50.1794 20.8561 51.3035 17.916L52.7251 14.1787C52.7665 14.079 52.783 13.9711 52.783 13.8631C52.783 13.805 52.7747 13.7468 52.7665 13.6887C51.163 6.38841 44.6746 0.931885 36.9299 0.931885C29.7886 0.931885 23.7218 5.56619 21.548 12.0027C20.1428 10.948 18.3492 10.3832 16.4151 10.5742C12.985 10.9147 10.2326 13.6887 9.89371 17.1353C9.80279 18.0323 9.87718 18.8877 10.0838 19.7016C4.48813 19.8678 0 24.4771 0 30.133C0 30.6479 0.0413271 31.1462 0.107451 31.6445C0.140512 31.8854 0.347148 32.0598 0.586845 32.0598L46.2037 32.0681C46.212 32.0681 46.212 32.0681 46.2203 32.0681C46.4765 32.0598 46.7079 31.8854 46.7823 31.6279Z"
									fill="white"
								/>
								<path
									d="M55.0145 14.4528C54.7831 14.4528 54.5599 14.4611 54.3285 14.4694C54.2872 14.4694 54.2541 14.4777 54.221 14.4943C54.1053 14.5358 54.0061 14.6355 53.9731 14.7601L52.9978 18.132C52.5762 19.5771 52.7333 20.9225 53.4358 21.9025C54.0805 22.8078 55.155 23.3393 56.461 23.4058L61.7261 23.7214C61.8831 23.7297 62.0154 23.8044 62.098 23.929C62.1889 24.0536 62.2055 24.2197 62.1559 24.3775C62.0732 24.6183 61.8335 24.8093 61.5856 24.8177L56.1138 25.1333C53.1465 25.2744 49.9395 27.6829 48.8154 30.623L48.4187 31.6611C48.3443 31.8522 48.4848 32.0515 48.6749 32.0598C48.6832 32.0598 48.6832 32.0598 48.6915 32.0598H67.5284C67.7516 32.0598 67.9499 31.9103 68.0161 31.6944C68.3467 30.5233 68.5203 29.2942 68.5203 28.0152C68.5203 20.5322 62.47 14.4528 55.0145 14.4528Z"
									fill="rgba(255,255,255,0.85)"
								/>
							</svg>
							<div class="flex items-center gap-3">
								<span
									class="text-white font-bold text-xl tracking-tight"
									style="text-shadow: 0 1px 2px rgba(0,0,0,0.15);"
								>
									Cloudflare
								</span>
								<span class="text-white/50 text-xl font-light">|</span>
								<span class="text-white font-medium text-lg">
									Prometheus Exporter
								</span>
							</div>
						</div>
						<h1
							class="text-4xl md:text-5xl font-extrabold text-white mb-4 tracking-tight"
							style="text-shadow: 0 2px 4px rgba(0,0,0,0.2);"
						>
							Cloudflare Metrics
							<br />
							for Prometheus
						</h1>
						<p
							class="text-white text-lg max-w-xl mb-8"
							style="text-shadow: 0 1px 2px rgba(0,0,0,0.15);"
						>
							Export zone analytics, HTTP metrics, and performance data from
							Cloudflare's GraphQL API directly to Prometheus format.
						</p>
						<div class="flex flex-wrap gap-4">
							<a
								href={config.metricsPath}
								class="inline-flex items-center gap-2 px-6 py-3 bg-white text-[#f6821f] font-semibold rounded-full hover:bg-white/90 transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5"
							>
								<svg
									aria-hidden="true"
									class="w-5 h-5"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
									/>
								</svg>
								View Metrics
							</a>
							<a
								href="/health"
								class="inline-flex items-center gap-2 px-6 py-3 bg-white/10 text-white font-semibold rounded-full border border-white/20 hover:bg-white/20 transition-all"
							>
								<svg
									aria-hidden="true"
									class="w-5 h-5"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
									/>
								</svg>
								Health Check
							</a>
						</div>
					</div>
				</div>

				<div class="max-w-5xl mx-auto px-6 py-12">
					{/* Feature Cards */}
					<h2 class="text-2xl font-bold text-gray-900 mb-6">Features</h2>
					<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
						<div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-shadow">
							<div class="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center mb-3">
								<svg
									aria-hidden="true"
									class="w-5 h-5 text-[#f6821f]"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
									/>
								</svg>
							</div>
							<h3 class="font-semibold text-gray-900 mb-1">GraphQL + REST</h3>
							<p class="text-sm text-gray-600">
								Hybrid API approach for comprehensive metrics
							</p>
						</div>

						<div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-shadow">
							<div class="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center mb-3">
								<svg
									aria-hidden="true"
									class="w-5 h-5 text-[#f6821f]"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
									/>
								</svg>
							</div>
							<h3 class="font-semibold text-gray-900 mb-1">Durable Objects</h3>
							<p class="text-sm text-gray-600">
								Stateful counter accumulation at the edge
							</p>
						</div>

						<div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-shadow">
							<div class="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center mb-3">
								<svg
									aria-hidden="true"
									class="w-5 h-5 text-[#f6821f]"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"
									/>
								</svg>
							</div>
							<h3 class="font-semibold text-gray-900 mb-1">Zone Filtering</h3>
							<p class="text-sm text-gray-600">
								Include or exclude specific zones
							</p>
						</div>

						<div class="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-shadow">
							<div class="w-10 h-10 rounded-lg bg-orange-100 flex items-center justify-center mb-3">
								<svg
									aria-hidden="true"
									class="w-5 h-5 text-[#f6821f]"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
									/>
								</svg>
							</div>
							<h3 class="font-semibold text-gray-900 mb-1">Real-time</h3>
							<p class="text-sm text-gray-600">
								Live metrics updated every scrape
							</p>
						</div>
					</div>
					{/* Configuration */}
					<h2 class="text-2xl font-bold text-gray-900 mb-6">Configuration</h2>
					{/* Service Status Card */}
					<div class="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm mb-6">
						<div class="flex items-center justify-between mb-4">
							<div class="flex items-center gap-4">
								<div
									id="health-indicator"
									class="w-3 h-3 rounded-full bg-gray-300"
								/>
								<div>
									<h3 class="font-semibold text-gray-900">Service Status</h3>
									<p id="health-status" class="text-sm text-gray-500">
										Checking...
									</p>
								</div>
							</div>
							<div
								id="health-badge"
								class="px-4 py-2 rounded-full text-sm font-medium bg-gray-100 text-gray-600"
							>
								Unknown
							</div>
						</div>
						<div
							id="health-details"
							class="border-t border-gray-100 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4"
						>
							<div class="flex flex-col py-2 px-3 rounded-lg bg-gray-50">
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-2">
										<div
											id="cf-api-indicator"
											class="w-2 h-2 rounded-full bg-gray-300"
										/>
										<span class="text-sm text-gray-600">
											Cloudflare REST API
										</span>
									</div>
									<span
										id="cf-api-latency"
										class="text-xs font-mono text-gray-400"
									>
										—
									</span>
								</div>
								<p id="cf-api-error" class="text-xs text-red-500 mt-1 hidden" />
							</div>
							<div class="flex flex-col py-2 px-3 rounded-lg bg-gray-50">
								<div class="flex items-center justify-between">
									<div class="flex items-center gap-2">
										<div
											id="gql-api-indicator"
											class="w-2 h-2 rounded-full bg-gray-300"
										/>
										<span class="text-sm text-gray-600">GraphQL API</span>
									</div>
									<span
										id="gql-api-latency"
										class="text-xs font-mono text-gray-400"
									>
										—
									</span>
								</div>
								<p
									id="gql-api-error"
									class="text-xs text-red-500 mt-1 hidden"
								/>
							</div>
						</div>
						<p
							id="health-timestamp"
							class="text-xs text-gray-400 mt-3 text-right"
						>
							—
						</p>
					</div>
					{/* Runtime Configuration Card */}
					{!config.disableConfigApi && (
					<div class="bg-white rounded-2xl border border-gray-200 shadow-sm mb-12 overflow-hidden">
						{/* Header with Save/Reset buttons */}
						<div class="flex items-center justify-between p-6 border-b border-gray-100">
							<div>
								<h3 class="font-semibold text-gray-900">
									Runtime Configuration
								</h3>
								<p id="config-status" class="text-sm text-gray-500">
									Loading...
								</p>
							</div>
							<div class="flex gap-2">
								<button
									type="button"
									id="reset-all-btn"
									onclick="resetAllConfig()"
									class="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								>
									Reset All
								</button>
								<button
									type="button"
									id="save-btn"
									onclick="saveConfig()"
									disabled
									class="px-4 py-2 text-sm bg-[#f6821f] text-white rounded-lg hover:bg-[#e57200] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
								>
									Save Changes
								</button>
							</div>
						</div>

						{/* Tab Navigation */}
						<div class="border-b border-gray-200">
							<div class="flex -mb-px px-6" role="tablist">
								<button
									type="button"
									onclick="switchTab('timing')"
									class="tab-btn active"
									data-tab="timing"
								>
									Timing
								</button>
								<button
									type="button"
									onclick="switchTab('cache')"
									class="tab-btn"
									data-tab="cache"
								>
									Cache
								</button>
								<button
									type="button"
									onclick="switchTab('filters')"
									class="tab-btn"
									data-tab="filters"
								>
									Filters
								</button>
								<button
									type="button"
									onclick="switchTab('output')"
									class="tab-btn"
									data-tab="output"
								>
									Output
								</button>
							</div>
						</div>

						{/* Tab Panels */}
						<div class="p-6">
							{/* Timing Tab */}
							<div id="tab-timing" class="tab-panel">
								<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
									<div>
										<label
											for="cfg-queryLimit"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Query Limit
										</label>
										<div class="field-wrapper">
											<input
												type="number"
												id="cfg-queryLimit"
												class="config-input pr-8"
												min="1"
												onchange="onFieldChange('queryLimit', parseInt(this.value))"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('queryLimit')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">
											Max results per GraphQL query
										</p>
									</div>
									<div>
										<label
											for="cfg-scrapeDelaySeconds"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Scrape Delay (seconds)
										</label>
										<div class="field-wrapper">
											<input
												type="number"
												id="cfg-scrapeDelaySeconds"
												class="config-input pr-8"
												min="0"
												onchange="onFieldChange('scrapeDelaySeconds', parseInt(this.value))"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('scrapeDelaySeconds')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">
											Delay before fetching metrics
										</p>
									</div>
									<div>
										<label
											for="cfg-timeWindowSeconds"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Time Window (seconds)
										</label>
										<div class="field-wrapper">
											<input
												type="number"
												id="cfg-timeWindowSeconds"
												class="config-input pr-8"
												min="1"
												onchange="onFieldChange('timeWindowSeconds', parseInt(this.value))"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('timeWindowSeconds')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">Query time window</p>
									</div>
									<div>
										<label
											for="cfg-metricRefreshIntervalSeconds"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Refresh Interval (seconds)
										</label>
										<div class="field-wrapper">
											<input
												type="number"
												id="cfg-metricRefreshIntervalSeconds"
												class="config-input pr-8"
												min="1"
												onchange="onFieldChange('metricRefreshIntervalSeconds', parseInt(this.value))"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('metricRefreshIntervalSeconds')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">
											Background refresh interval
										</p>
									</div>
								</div>
							</div>

							{/* Cache Tab */}
							<div id="tab-cache" class="tab-panel hidden">
								<div class="grid grid-cols-1 md:grid-cols-3 gap-6">
									<div>
										<label
											for="cfg-accountListCacheTtlSeconds"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Account List TTL (seconds)
										</label>
										<div class="field-wrapper">
											<input
												type="number"
												id="cfg-accountListCacheTtlSeconds"
												class="config-input pr-8"
												min="0"
												onchange="onFieldChange('accountListCacheTtlSeconds', parseInt(this.value))"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('accountListCacheTtlSeconds')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
									</div>
									<div>
										<label
											for="cfg-zoneListCacheTtlSeconds"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Zone List TTL (seconds)
										</label>
										<div class="field-wrapper">
											<input
												type="number"
												id="cfg-zoneListCacheTtlSeconds"
												class="config-input pr-8"
												min="0"
												onchange="onFieldChange('zoneListCacheTtlSeconds', parseInt(this.value))"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('zoneListCacheTtlSeconds')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
									</div>
									<div>
										<label
											for="cfg-sslCertsCacheTtlSeconds"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											SSL Certs TTL (seconds)
										</label>
										<div class="field-wrapper">
											<input
												type="number"
												id="cfg-sslCertsCacheTtlSeconds"
												class="config-input pr-8"
												min="0"
												onchange="onFieldChange('sslCertsCacheTtlSeconds', parseInt(this.value))"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('sslCertsCacheTtlSeconds')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
									</div>
								</div>
							</div>

							{/* Filters Tab */}
							<div id="tab-filters" class="tab-panel hidden">
								<div class="space-y-6">
									<div>
										<div class="flex items-center justify-between mb-2">
											<label
												for="cfg-cfAccounts"
												class="block text-sm font-medium text-gray-700"
											>
												Accounts Filter
											</label>
											<label class="flex items-center gap-2 text-sm text-gray-600">
												<input
													type="checkbox"
													id="cfg-cfAccounts-all"
													class="rounded border-gray-300 text-[#f6821f] focus:ring-[#f6821f]"
													onchange="toggleAllFilter('cfAccounts', this.checked)"
												/>
												All accounts
											</label>
										</div>
										<div class="field-wrapper">
											<input
												type="text"
												id="cfg-cfAccounts"
												class="config-input pr-8"
												placeholder="account-id-1, account-id-2"
												onchange="onFieldChange('cfAccounts', this.value || null)"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('cfAccounts')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">
											Comma-separated account IDs (empty = all)
										</p>
									</div>
									<div>
										<div class="flex items-center justify-between mb-2">
											<label
												for="cfg-cfZones"
												class="block text-sm font-medium text-gray-700"
											>
												Zones Filter
											</label>
											<label class="flex items-center gap-2 text-sm text-gray-600">
												<input
													type="checkbox"
													id="cfg-cfZones-all"
													class="rounded border-gray-300 text-[#f6821f] focus:ring-[#f6821f]"
													onchange="toggleAllFilter('cfZones', this.checked)"
												/>
												All zones
											</label>
										</div>
										<div class="field-wrapper">
											<input
												type="text"
												id="cfg-cfZones"
												class="config-input pr-8"
												placeholder="zone-id-1, zone-id-2"
												onchange="onFieldChange('cfZones', this.value || null)"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('cfZones')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">
											Comma-separated zone IDs (empty = all)
										</p>
									</div>
									<div>
										<label
											for="cfg-cfFreeTierAccounts"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Free Tier Accounts
										</label>
										<div class="field-wrapper">
											<input
												type="text"
												id="cfg-cfFreeTierAccounts"
												class="config-input pr-8"
												placeholder="account-id-1, account-id-2"
												onchange="onFieldChange('cfFreeTierAccounts', this.value)"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('cfFreeTierAccounts')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">
											Accounts using free tier (skips paid-tier metrics)
										</p>
									</div>
									<div>
										<label
											for="cfg-metricsDenylist"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Metrics Denylist
										</label>
										<div class="field-wrapper">
											<input
												type="text"
												id="cfg-metricsDenylist"
												class="config-input pr-8"
												placeholder="metric_name_1, metric_name_2"
												onchange="onFieldChange('metricsDenylist', this.value)"
											/>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('metricsDenylist')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
										<p class="text-xs text-gray-500 mt-1">
											Metrics to exclude from output
										</p>
									</div>
								</div>
							</div>

							{/* Output Tab */}
							<div id="tab-output" class="tab-panel hidden">
								<div class="grid grid-cols-1 md:grid-cols-2 gap-6">
									<div>
										<label
											for="cfg-logLevel"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Log Level
										</label>
										<div class="field-wrapper">
											<select
												id="cfg-logLevel"
												class="config-input pr-8"
												onchange="onFieldChange('logLevel', this.value)"
											>
												<option value="debug">Debug</option>
												<option value="info">Info</option>
												<option value="warn">Warning</option>
												<option value="error">Error</option>
											</select>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('logLevel')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
									</div>
									<div>
										<label
											for="cfg-logFormat"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Log Format
										</label>
										<div class="field-wrapper">
											<select
												id="cfg-logFormat"
												class="config-input pr-8"
												onchange="onFieldChange('logFormat', this.value)"
											>
												<option value="json">JSON</option>
												<option value="pretty">Pretty</option>
											</select>
											<button
												type="button"
												class="field-reset"
												onclick="resetField('logFormat')"
												title="Reset to default"
											>
												<svg
													class="w-4 h-4"
													fill="none"
													stroke="currentColor"
													viewBox="0 0 24 24"
													aria-hidden="true"
												>
													<path
														stroke-linecap="round"
														stroke-linejoin="round"
														stroke-width="2"
														d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
													/>
												</svg>
											</button>
										</div>
									</div>
									<div>
										<label
											for="cfg-excludeHost"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											Exclude Host Label
										</label>
										<div class="flex items-center justify-between">
											<p class="text-xs text-gray-500">
												Remove host labels from metrics
											</p>
											<button
												type="button"
												id="cfg-excludeHost"
												class="toggle-switch"
												onclick="toggleSwitch('excludeHost')"
												role="switch"
												aria-checked="false"
											/>
										</div>
									</div>
									<div>
										<label
											for="cfg-httpStatusGroup"
											class="block text-sm font-medium text-gray-700 mb-2"
										>
											HTTP Status Grouping
										</label>
										<div class="flex items-center justify-between">
											<p class="text-xs text-gray-500">
												Group status codes (2xx, 4xx, etc.)
											</p>
											<button
												type="button"
												id="cfg-httpStatusGroup"
												class="toggle-switch"
												onclick="toggleSwitch('httpStatusGroup')"
												role="switch"
												aria-checked="false"
											/>
										</div>
									</div>
								</div>
							</div>
						</div>
					</div>
					)}
					{/* Toast notification */}
					<div id="toast" class="toast" /> {/* Live Metrics Section */}
					<h2 class="text-2xl font-bold text-gray-900 mb-6">Live Metrics</h2>
					<div class="bg-white rounded-2xl border border-gray-200 shadow-sm mb-12 overflow-hidden">
						<div class="p-4 border-b border-gray-100 flex items-center justify-between">
							<div class="flex items-center gap-2">
								<div
									id="metrics-indicator"
									class="w-2 h-2 rounded-full bg-gray-300"
								/>
								<span class="text-sm font-medium text-gray-700">
									Prometheus Metrics
								</span>
							</div>
							<button
								type="button"
								onclick="fetchMetrics()"
								class="text-sm text-[#f6821f] hover:text-[#e57200] font-medium flex items-center gap-1"
							>
								<svg
									id="refresh-icon"
									aria-hidden="true"
									class="w-4 h-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
									/>
								</svg>
								Refresh
							</button>
						</div>
						<div
							id="metrics-container"
							class="p-4 bg-gray-900 h-80 overflow-auto"
						>
							<pre
								id="metrics-output"
								class="text-sm text-gray-300 font-mono whitespace-pre-wrap"
							>
								Loading metrics...
							</pre>
						</div>
						<div class="p-3 bg-gray-50 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
							<span id="metrics-count">-</span>
							<span id="metrics-timestamp">-</span>
						</div>
					</div>
					{/* Footer */}
					<div class="text-center text-sm text-gray-500 py-8">
						<p>Built with Cloudflare Workers &amp; Durable Objects</p>
						<p class="text-xs text-gray-400 mt-2">
							This UI can be disabled via{" "}
							<code class="bg-gray-100 px-1 rounded">DISABLE_UI</code> env var
						</p>
					</div>
				</div>

				<LandingPageScript metricsPath={config.metricsPath} disableConfigApi={config.disableConfigApi} />
			</body>
		</html>
	);
};
