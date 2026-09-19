export const MEDIA_SETTING_OPTIONS = {
  videoRecordingSize: [
    { value: '480x640', label: '480 x 640' },
    { value: '600x800', label: '600 x 800' },
    { value: '720x1280', label: '720 x 1280' },
    { value: '1080x1920', label: '1080 x 1920' },
  ],
  videoRecordingFps: [
    { value: '15', label: '15 fps' },
    { value: '24', label: '24 fps' },
    { value: '30', label: '30 fps' },
  ],
  videoRecordingVideoBitrate: [
    { value: '750000', label: '750 kbps' },
    { value: '1000000', label: '1 Mbps' },
    { value: '1500000', label: '1.5 Mbps' },
    { value: '2500000', label: '2.5 Mbps' },
  ],
  videoRecordingAudioBitrate: [
    { value: '64000', label: '64 kbps' },
    { value: '96000', label: '96 kbps' },
    { value: '128000', label: '128 kbps' },
  ],
  videoConversionSize: [
    { value: '480x640', label: '480 x 640' },
    { value: '600x800', label: '600 x 800' },
    { value: '720x1280', label: '720 x 1280' },
    { value: '1080x1920', label: '1080 x 1920' },
  ],
  videoConversionFps: [
    { value: '15', label: '15 fps' },
    { value: '24', label: '24 fps' },
    { value: '30', label: '30 fps' },
  ],
  videoConversionVideoBitrate: [
    { value: '750k', label: '750 kbps' },
    { value: '1000k', label: '1 Mbps' },
    { value: '1500k', label: '1.5 Mbps' },
    { value: '2500k', label: '2.5 Mbps' },
  ],
  videoConversionAudioBitrate: [
    { value: '64k', label: '64 kbps' },
    { value: '96k', label: '96 kbps' },
    { value: '128k', label: '128 kbps' },
  ],
  imageMaxDimension: [
    { value: '1280', label: '1280 px' },
    { value: '1600', label: '1600 px' },
    { value: '2000', label: '2000 px' },
    { value: '2560', label: '2560 px' },
  ],
  audioUploadFormat: [
    { value: 'opus', label: 'WebM / Opus' },
    { value: 'aac', label: 'M4A / AAC' },
    { value: 'wav', label: 'WAV PCM' },
  ],
  audioUploadBitrate: [
    { value: '32k', label: '32 kbps' },
    { value: '48k', label: '48 kbps' },
    { value: '64k', label: '64 kbps' },
    { value: '96k', label: '96 kbps' },
  ],
  audioRecordingSampleRate: [
    { value: '44100', label: '44.1 kHz' },
    { value: '48000', label: '48 kHz' },
  ],
  audioRecordingMaxSeconds: [
    { value: '60', label: '1 minute' },
    { value: '180', label: '3 minutes' },
    { value: '300', label: '5 minutes' },
    { value: '600', label: '10 minutes' },
  ],
} as const;

export const MEDIA_SETTING_KEYS = [
  'video_recording_size',
  'video_recording_fps',
  'video_recording_video_bitrate',
  'video_recording_audio_bitrate',
  'video_conversion_size',
  'video_conversion_fps',
  'video_conversion_video_bitrate',
  'video_conversion_audio_bitrate',
  'image_max_dimension',
  'audio_upload_format',
  'audio_upload_bitrate',
  'audio_recording_sample_rate',
  'audio_recording_max_seconds',
  'audio_echo_cancellation',
  'audio_noise_suppression',
  'audio_auto_gain_control',
] as const;

export const MEDIA_SETTING_DEFAULTS: Record<typeof MEDIA_SETTING_KEYS[number], string> = {
  video_recording_size: '600x800',
  video_recording_fps: '24',
  video_recording_video_bitrate: '1000000',
  video_recording_audio_bitrate: '128000',
  video_conversion_size: '600x800',
  video_conversion_fps: '24',
  video_conversion_video_bitrate: '1000k',
  video_conversion_audio_bitrate: '128k',
  image_max_dimension: '2000',
  audio_upload_format: 'wav',
  audio_upload_bitrate: '48k',
  audio_recording_sample_rate: '48000',
  audio_recording_max_seconds: '300',
  audio_echo_cancellation: '0',
  audio_noise_suppression: '0',
  audio_auto_gain_control: '0',
};

export function normalizeMediaSetting(key: string, value: unknown): string | null {
  const text = String(value ?? '');
  switch (key) {
    case 'video_recording_size':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoRecordingSize);
    case 'video_recording_fps':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoRecordingFps);
    case 'video_recording_video_bitrate':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoRecordingVideoBitrate);
    case 'video_recording_audio_bitrate':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoRecordingAudioBitrate);
    case 'video_conversion_size':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoConversionSize);
    case 'video_conversion_fps':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoConversionFps);
    case 'video_conversion_video_bitrate':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoConversionVideoBitrate);
    case 'video_conversion_audio_bitrate':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.videoConversionAudioBitrate);
    case 'image_max_dimension':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.imageMaxDimension);
    case 'audio_upload_format':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.audioUploadFormat);
    case 'audio_upload_bitrate':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.audioUploadBitrate);
    case 'audio_recording_sample_rate':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.audioRecordingSampleRate);
    case 'audio_recording_max_seconds':
      return selectAllowed(text, MEDIA_SETTING_OPTIONS.audioRecordingMaxSeconds);
    case 'audio_echo_cancellation':
    case 'audio_noise_suppression':
    case 'audio_auto_gain_control':
      return text === '1' || text === 'true' ? '1' : '0';
    default:
      return null;
  }
}

function selectAllowed<T extends readonly { value: string }[]>(value: string, options: T): string {
  return options.some(option => option.value === value) ? value : options[0].value;
}
