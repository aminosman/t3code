Pod::Spec.new do |s|
  s.name           = 'T3VoiceDiagnostics'
  s.version        = '1.0.0'
  s.summary        = 'On-device voice, audio-route, and MetricKit diagnostics for T3 Code mobile.'
  s.author         = 'T3 Tools'
  s.homepage       = 'https://t3tools.com'
  s.platforms      = { :ios => '16.4' }
  s.source         = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
