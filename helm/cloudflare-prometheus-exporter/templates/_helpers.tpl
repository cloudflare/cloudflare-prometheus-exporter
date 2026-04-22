{{/*
Expand the name of the chart.
*/}}
{{- define "cloudflare-prometheus-exporter.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "cloudflare-prometheus-exporter.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "cloudflare-prometheus-exporter.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "cloudflare-prometheus-exporter.labels" -}}
helm.sh/chart: {{ include "cloudflare-prometheus-exporter.chart" . }}
{{ include "cloudflare-prometheus-exporter.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "cloudflare-prometheus-exporter.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cloudflare-prometheus-exporter.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "cloudflare-prometheus-exporter.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "cloudflare-prometheus-exporter.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the Secret that holds the Cloudflare API token.
Uses existingSecret when provided, otherwise the chart-managed secret.
*/}}
{{- define "cloudflare-prometheus-exporter.secretName" -}}
{{- if .Values.cloudflare.existingSecret }}
{{- .Values.cloudflare.existingSecret }}
{{- else }}
{{- include "cloudflare-prometheus-exporter.fullname" . }}
{{- end }}
{{- end }}

{{/*
Name of the Secret that holds Basic Auth credentials.
Uses existingSecret when provided, otherwise the chart-managed secret.
*/}}
{{- define "cloudflare-prometheus-exporter.basicAuthSecretName" -}}
{{- if .Values.basicAuth.existingSecret }}
{{- .Values.basicAuth.existingSecret }}
{{- else }}
{{- printf "%s-basic-auth" (include "cloudflare-prometheus-exporter.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Validate that the Cloudflare API token is provided either inline or via existingSecret.
*/}}
{{- define "cloudflare-prometheus-exporter.validateValues" -}}
{{- if and (not .Values.cloudflare.apiToken) (not .Values.cloudflare.existingSecret) }}
{{- fail "Either cloudflare.apiToken or cloudflare.existingSecret must be set." }}
{{- end }}
{{- if and .Values.basicAuth.enabled (not .Values.basicAuth.existingSecret) }}
  {{- if not .Values.basicAuth.username }}
  {{- fail "basicAuth.username must be set when basicAuth.enabled=true and no existingSecret is provided." }}
  {{- end }}
  {{- if not .Values.basicAuth.password }}
  {{- fail "basicAuth.password must be set when basicAuth.enabled=true and no existingSecret is provided." }}
  {{- end }}
{{- end }}
{{- end }}
