#pragma once
#include <string>
// Deliberately case-sensitive: these are libuv's two literal generated prefixes.
// No basename matching, generic PIPE rewrite, suffix matching, or host IPC alias.
inline bool crotLocalPipeName(const wchar_t* input, std::wstring& output) {
 if(!input)return false;
 const std::wstring name(input), extended=L"\\\\?\\pipe\\uv\\", ordinary=L"\\\\.\\pipe\\uv\\";
 if(name.compare(0,extended.size(),extended)!=0 && name.compare(0,ordinary.size(),ordinary)!=0)return false;
 if(name.size()<=extended.size() || name.size()>32700)return false;
 output=L"\\\\.\\pipe\\LOCAL\\uv\\"+name.substr(extended.size());return true;
}
