{{/* The chart name, cut to the 63 characters a label allows. */}}
{{- define "riosoma.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* The release's full name, which names every object the chart makes. */}}
{{- define "riosoma.fullname" -}}
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

{{- define "riosoma.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "riosoma.selectorLabels" -}}
app.kubernetes.io/name: {{ include "riosoma.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "riosoma.labels" -}}
helm.sh/chart: {{ include "riosoma.chart" . }}
{{ include "riosoma.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "riosoma.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "riosoma.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "riosoma.image" -}}
{{- if .Values.image.digest }}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest }}
{{- else }}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}
{{- end }}

{{- define "riosoma.connectors.fullname" -}}
{{- printf "%s-connectors" (include "riosoma.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "riosoma.connectors.selectorLabels" -}}
app.kubernetes.io/name: {{ include "riosoma.name" . }}-connectors
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "riosoma.connectors.image" -}}
{{- if .Values.connectors.image.digest }}
{{- printf "%s@%s" .Values.connectors.image.repository .Values.connectors.image.digest }}
{{- else }}
{{- /* The connector service runs the same release as the server unless told otherwise. */}}
{{- printf "%s:%s" .Values.connectors.image.repository (default (default .Chart.AppVersion .Values.image.tag) .Values.connectors.image.tag) }}
{{- end }}
{{- end }}

{{/* The Secret holding the token the server and the connector service share. */}}
{{- define "riosoma.connectors.secretName" -}}
{{- default (include "riosoma.connectors.fullname" .) .Values.connectors.existingSecret }}
{{- end }}

{{/* The Secret the container reads its secret settings from. */}}
{{- define "riosoma.secretName" -}}
{{- default (include "riosoma.fullname" .) .Values.secret.existingSecret }}
{{- end }}

{{- define "riosoma.postgresql.fullname" -}}
{{- printf "%s-postgresql" (include "riosoma.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "riosoma.postgresql.selectorLabels" -}}
app.kubernetes.io/name: {{ include "riosoma.name" . }}-postgresql
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Non-secret settings: the values given, minus empty ones, plus defaults the ingress implies.
*/}}
{{- define "riosoma.settings" -}}
{{- $settings := dict }}
{{- range $name, $value := .Values.settings }}
{{- if and (not (kindIs "invalid" $value)) (ne (toString $value) "") }}
{{- $_ := set $settings $name (toString $value) }}
{{- end }}
{{- end }}
{{- if .Values.ingress.enabled }}
{{- if not (hasKey $settings "RIOSOMA_BASE_URL") }}
{{- $_ := set $settings "RIOSOMA_BASE_URL" (printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host) }}
{{- end }}
{{- if not (hasKey $settings "RIOSOMA_TRUST_PROXY") }}
{{- $_ := set $settings "RIOSOMA_TRUST_PROXY" "1" }}
{{- end }}
{{- end }}
{{- /* The update notice shows Helm's steps for a server this chart installed. */}}
{{- if not (hasKey $settings "RIOSOMA_INSTALL_METHOD") }}
{{- $_ := set $settings "RIOSOMA_INSTALL_METHOD" "helm" }}
{{- end }}
{{- if and .Values.clamav.enabled (not (hasKey $settings "RIOSOMA_CLAMAV_URL")) }}
{{- $_ := set $settings "RIOSOMA_CLAMAV_URL" (printf "tcp://%s-clamav:3310" (include "riosoma.fullname" .)) }}
{{- end }}
{{- if and .Values.connectors.enabled (not (hasKey $settings "RIOSOMA_CONNECTOR_SERVICE_URL")) }}
{{- $_ := set $settings "RIOSOMA_CONNECTOR_SERVICE_URL" (printf "http://%s:8091" (include "riosoma.connectors.fullname" .)) }}
{{- end }}
{{- if and .Values.search.enabled (not (hasKey $settings "RIOSOMA_SEARCH_URL")) }}
{{- $_ := set $settings "RIOSOMA_SEARCH_URL" (printf "http://%s-search:8080" (include "riosoma.fullname" .)) }}
{{- end }}
{{- toYaml $settings }}
{{- end }}
