{{- define "grant-sift.volumeMounts" -}}
{{- if .Values.persistence.enabled }}
- name: data
  mountPath: /data
{{- end }}
{{- if .Values.roster.existingConfigMap }}
- name: roster
  mountPath: {{ .Values.roster.mountPath | quote }}
  subPath: {{ .Values.roster.key | quote }}
  readOnly: true
{{- if .Values.roster.staffKey }}
- name: roster
  mountPath: {{ .Values.roster.staffMountPath | default "/app/config/staff.yaml" | quote }}
  subPath: {{ .Values.roster.staffKey | quote }}
  readOnly: true
{{- end }}
{{- end }}
{{- if .Values.sources.existingConfigMap }}
- name: sources
  mountPath: /app/config/sources.yaml
  subPath: {{ .Values.sources.key | quote }}
  readOnly: true
{{- end }}
{{- if .Values.profile.existingConfigMap }}
- name: profile
  mountPath: /app/config/profile.yaml
  subPath: {{ .Values.profile.key | quote }}
  readOnly: true
{{- end }}
{{- end }}

{{- define "grant-sift.volumes" -}}
{{- if .Values.persistence.enabled }}
- name: data
  persistentVolumeClaim:
    claimName: {{ include "grant-sift.pvcName" . }}
{{- end }}
{{- if .Values.roster.existingConfigMap }}
- name: roster
  configMap:
    name: {{ .Values.roster.existingConfigMap | quote }}
{{- end }}
{{- if .Values.sources.existingConfigMap }}
- name: sources
  configMap:
    name: {{ .Values.sources.existingConfigMap | quote }}
{{- end }}
{{- if .Values.profile.existingConfigMap }}
- name: profile
  configMap:
    name: {{ .Values.profile.existingConfigMap | quote }}
{{- end }}
{{- end }}
