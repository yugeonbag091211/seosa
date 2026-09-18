import { memo } from 'react';
import { View } from 'react-native';
import { SvgXml } from 'react-native-svg';

/*
 * The web hero's bookshelf still (public/index.html svg.hero-still, viewBox 460x340), copied verbatim
 * except for the floor shadow: its three feGaussianBlur filters are not supported by react-native-svg,
 * so they are replaced with unblurred shapes at lower opacity. Decorative only (no links in the app).
 */
const SHELF = `<svg viewBox="0 0 460 340" xmlns="http://www.w3.org/2000/svg">
<defs>
<linearGradient id="bsCurve" x1="0" y1="0" x2="1" y2="0">
<stop offset="0%" stop-color="#000" stop-opacity=".34"/><stop offset="4%" stop-color="#000" stop-opacity=".14"/>
<stop offset="13%" stop-color="#000" stop-opacity=".04"/><stop offset="27%" stop-color="#fff" stop-opacity=".15"/>
<stop offset="40%" stop-color="#fff" stop-opacity=".08"/><stop offset="52%" stop-color="#fff" stop-opacity=".02"/>
<stop offset="68%" stop-color="#000" stop-opacity=".05"/><stop offset="86%" stop-color="#000" stop-opacity=".13"/>
<stop offset="97.5%" stop-color="#fff" stop-opacity=".07"/><stop offset="100%" stop-color="#000" stop-opacity=".28"/>
</linearGradient>
<linearGradient id="bsVert" x1="0" y1="0" x2="0" y2="1">
<stop offset="0%" stop-color="#fff" stop-opacity=".09"/><stop offset="12%" stop-color="#fff" stop-opacity=".03"/>
<stop offset="46%" stop-color="#000" stop-opacity="0"/><stop offset="82%" stop-color="#000" stop-opacity=".06"/>
<stop offset="91%" stop-color="#fff" stop-opacity=".03"/><stop offset="100%" stop-color="#000" stop-opacity=".26"/>
</linearGradient>
<clipPath id="bsClip0"><rect x="56.3" y="22.2" width="52.6" height="273.8" rx="1.2"/></clipPath>
<clipPath id="bsClip1"><rect x="108.9" y="32.8" width="44.5" height="263.3" rx="1.2"/></clipPath>
<clipPath id="bsClip2"><rect x="153.4" y="32.8" width="35.1" height="263.3" rx="1.2"/></clipPath>
<clipPath id="bsClip3"><rect x="188.5" y="32.8" width="31.6" height="263.3" rx="1.2"/></clipPath>
<clipPath id="bsClip4"><rect x="220.1" y="32.8" width="29.3" height="263.3" rx="1.2"/></clipPath>
<clipPath id="bsClip5"><rect x="249.3" y="32.8" width="25.7" height="263.3" rx="1.2"/></clipPath>
<clipPath id="bsClip6"><rect x="275.0" y="50.3" width="30.4" height="245.7" rx="1.2"/></clipPath>
<clipPath id="bsClip7"><rect x="305.5" y="67.9" width="28.1" height="228.1" rx="1.2"/></clipPath>
<clipPath id="bsClip8"><rect x="333.5" y="73.7" width="25.7" height="222.3" rx="1.2"/></clipPath>
<clipPath id="bsClip9"><rect x="359.3" y="76.0" width="23.4" height="220.0" rx="1.2"/></clipPath>
<clipPath id="bsClip10"><rect x="382.7" y="76.0" width="21.1" height="220.0" rx="1.2"/></clipPath>
</defs>
<ellipse cx="230" cy="301" rx="196" ry="13" fill="#8A8375" opacity=".09"/>
<ellipse cx="224" cy="302" rx="138" ry="7" fill="#6B6558" opacity=".14"/>
<rect x="55" y="295" width="349" height="4" rx="2" fill="#544F44" opacity=".16"/>
<g clip-path="url(#bsClip0)">
<rect x="56.3" y="22.2" width="52.6" height="273.8" rx="1.2" fill="#0A0A0E"/>
<text font-size="15.0" font-weight="700" fill="#EDEAE3" text-anchor="middle"><tspan x="82.6" y="45.1">코</tspan><tspan x="82.6" y="61.0">스</tspan><tspan x="82.6" y="76.9">모</tspan><tspan x="82.6" y="92.8">스</tspan></text>
<text transform="translate(84.4 102.7) rotate(90)" font-size="5.1" font-weight="500" fill="#C8A951" letter-spacing="1">COSMOS</text>
<text font-size="4.5" font-weight="400" fill="#EDEAE3" opacity=".7" text-anchor="middle"><tspan x="82.6" y="258.4">사</tspan><tspan x="82.6" y="263.2">이</tspan><tspan x="82.6" y="268.0">언</tspan><tspan x="82.6" y="272.7">스</tspan><tspan x="82.6" y="277.5">북</tspan><tspan x="82.6" y="282.3">스</tspan></text>
<text font-size="5.4" font-weight="500" fill="#EDEAE3" opacity=".9" text-anchor="middle"><tspan x="82.6" y="227.1">칼</tspan><tspan x="82.6" y="235.2">세</tspan><tspan x="82.6" y="241.0">이</tspan><tspan x="82.6" y="246.7">건</tspan></text>
<rect x="56.3" y="22.2" width="52.6" height="273.8" rx="1.2" fill="url(#bsCurve)"/>
<rect x="56.3" y="22.2" width="52.6" height="273.8" rx="1.2" fill="url(#bsVert)"/>
</g>
<g transform="rotate(-0.2 131.1 296)" clip-path="url(#bsClip1)">
<rect x="108.9" y="32.8" width="44.5" height="263.3" rx="1.2" fill="#0B0B0B"/>
<rect x="138.2" y="32.8" width="2.8" height="263.3" fill="#E2342B"/><rect x="140.8" y="32.8" width="2.8" height="263.3" fill="#F08A1D"/>
<rect x="143.3" y="32.8" width="2.8" height="263.3" fill="#F5C518"/><rect x="145.8" y="32.8" width="2.8" height="263.3" fill="#2E9E52"/>
<rect x="148.3" y="32.8" width="2.8" height="263.3" fill="#2C6FBF"/><rect x="150.8" y="32.8" width="2.8" height="263.3" fill="#7A4B9E"/>
<text font-size="12.3" font-weight="700" fill="#F2F0EB" text-anchor="middle"><tspan x="123.6" y="51.7">이</tspan><tspan x="123.6" y="64.8">기</tspan><tspan x="123.6" y="77.9">적</tspan><tspan x="123.6" y="96.4">유</tspan><tspan x="123.6" y="109.5">전</tspan><tspan x="123.6" y="122.6">자</tspan></text>
<text transform="translate(125.3 130.7) rotate(90)" font-size="4.8" font-weight="500" fill="#F2F0EB" opacity=".72" letter-spacing="1">THE SELFISH GENE</text>
<text font-size="4.3" font-weight="400" fill="#F2F0EB" opacity=".7" text-anchor="middle"><tspan x="123.6" y="266.1">을</tspan><tspan x="123.6" y="270.6">유</tspan><tspan x="123.6" y="275.2">문</tspan><tspan x="123.6" y="279.7">화</tspan><tspan x="123.6" y="284.3">사</tspan></text>
<text font-size="4.6" font-weight="500" fill="#F2F0EB" opacity=".9" text-anchor="middle"><tspan x="123.6" y="229.5">리</tspan><tspan x="123.6" y="234.3">처</tspan><tspan x="123.6" y="239.2">드</tspan><tspan x="123.6" y="246.1">도</tspan><tspan x="123.6" y="251.0">킨</tspan><tspan x="123.6" y="255.9">스</tspan></text>
<rect x="108.9" y="32.8" width="44.5" height="263.3" rx="1.2" fill="url(#bsCurve)"/>
<rect x="108.9" y="32.8" width="44.5" height="263.3" rx="1.2" fill="url(#bsVert)"/>
</g>
<g clip-path="url(#bsClip2)">
<rect x="153.4" y="32.8" width="35.1" height="263.3" rx="1.2" fill="#F3F0E9"/>
<text font-size="9.6" font-weight="700" fill="#1F2A44" text-anchor="middle"><tspan x="170.9" y="47.6">워</tspan><tspan x="170.9" y="57.8">런</tspan><tspan x="170.9" y="72.3">버</tspan><tspan x="170.9" y="82.5">핏</tspan><tspan x="170.9" y="92.6">의</tspan><tspan x="170.9" y="107.1">주</tspan><tspan x="170.9" y="117.3">주</tspan><tspan x="170.9" y="131.7">서</tspan><tspan x="170.9" y="141.9">한</tspan></text>
<text transform="translate(172.1 148.3) rotate(90)" font-size="3.3" font-weight="500" fill="#B08D57" letter-spacing="1">The Essays of WARREN BUFFETT</text>
<text font-size="2.9" font-weight="400" fill="#1F2A44" opacity=".7" text-anchor="middle"><tspan x="170.9" y="271.6">에</tspan><tspan x="170.9" y="274.7">프</tspan><tspan x="170.9" y="277.7">엔</tspan><tspan x="170.9" y="280.8">미</tspan><tspan x="170.9" y="283.8">디</tspan><tspan x="170.9" y="286.9">어</tspan></text>
<text font-size="3.5" font-weight="500" fill="#1F2A44" opacity=".9" text-anchor="middle"><tspan x="170.9" y="242.7">워</tspan><tspan x="170.9" y="246.4">런</tspan><tspan x="170.9" y="251.6">버</tspan><tspan x="170.9" y="255.2">핏</tspan><tspan x="170.9" y="260.4">원</tspan><tspan x="170.9" y="264.1">저</tspan></text>
<rect x="153.4" y="32.8" width="35.1" height="263.3" rx="1.2" fill="url(#bsCurve)"/>
<rect x="153.4" y="32.8" width="35.1" height="263.3" rx="1.2" fill="url(#bsVert)"/>
</g>
<g clip-path="url(#bsClip3)">
<rect x="188.5" y="32.8" width="31.6" height="263.3" rx="1.2" fill="#14543F"/>
<text font-size="13.3" font-weight="700" fill="#F1EFE7" text-anchor="middle"><tspan x="204.3" y="49.9">돈</tspan><tspan x="204.3" y="64.0">의</tspan><tspan x="204.3" y="84.0">속</tspan><tspan x="204.3" y="98.0">성</tspan></text>
<text font-size="4.3" font-weight="400" fill="#F1EFE7" opacity=".7" text-anchor="middle"><tspan x="204.3" y="260.0">스</tspan><tspan x="204.3" y="264.6">노</tspan><tspan x="204.3" y="269.2">우</tspan><tspan x="204.3" y="273.7">폭</tspan><tspan x="204.3" y="278.3">스</tspan><tspan x="204.3" y="282.8">북</tspan><tspan x="204.3" y="287.4">스</tspan></text>
<text font-size="4.8" font-weight="500" fill="#F1EFE7" opacity=".9" text-anchor="middle"><tspan x="204.3" y="239.3">김</tspan><tspan x="204.3" y="244.3">승</tspan><tspan x="204.3" y="249.4">호</tspan></text>
<rect x="188.5" y="32.8" width="31.6" height="263.3" rx="1.2" fill="url(#bsCurve)"/>
<rect x="188.5" y="32.8" width="31.6" height="263.3" rx="1.2" fill="url(#bsVert)"/>
</g>
<g clip-path="url(#bsClip4)">
<rect x="220.1" y="32.8" width="29.3" height="263.3" rx="1.2" fill="#EDEAE4"/>
<text font-size="12.2" font-weight="700" fill="#2B2926" text-anchor="middle"><tspan x="234.7" y="48.6">아</tspan><tspan x="234.7" y="61.5">주</tspan><tspan x="234.7" y="79.8">작</tspan><tspan x="234.7" y="92.7">은</tspan><tspan x="234.7" y="111.0">습</tspan><tspan x="234.7" y="123.9">관</tspan><tspan x="234.7" y="136.8">의</tspan><tspan x="234.7" y="155.1">힘</tspan></text>
<text transform="translate(236.4 163.2) rotate(90)" font-size="4.8" font-weight="500" fill="#B08A4C" letter-spacing="1">Atomic Habits</text>
<text font-size="4.3" font-weight="400" fill="#2B2926" opacity=".7" text-anchor="middle"><tspan x="234.7" y="265.4">비</tspan><tspan x="234.7" y="269.9">즈</tspan><tspan x="234.7" y="274.4">니</tspan><tspan x="234.7" y="278.9">스</tspan><tspan x="234.7" y="283.4">북</tspan><tspan x="234.7" y="288.0">스</tspan></text>
<text font-size="4.6" font-weight="500" fill="#2B2926" opacity=".9" text-anchor="middle"><tspan x="234.7" y="229.1">제</tspan><tspan x="234.7" y="234.0">임</tspan><tspan x="234.7" y="238.8">스</tspan><tspan x="234.7" y="245.7">클</tspan><tspan x="234.7" y="250.5">리</tspan><tspan x="234.7" y="255.3">어</tspan></text>
<rect x="220.1" y="32.8" width="29.3" height="263.3" rx="1.2" fill="url(#bsCurve)"/>
<rect x="220.1" y="32.8" width="29.3" height="263.3" rx="1.2" fill="url(#bsVert)"/>
</g>
<g transform="rotate(0.25 262.2 296)" clip-path="url(#bsClip5)">
<rect x="249.3" y="32.8" width="25.7" height="263.3" rx="1.2" fill="#121316"/>
<text font-size="10.8" font-weight="700" fill="#F1F1EF" text-anchor="middle"><tspan x="262.2" y="47.1">진</tspan><tspan x="262.2" y="58.6">보</tspan><tspan x="262.2" y="70.0">를</tspan><tspan x="262.2" y="86.3">위</tspan><tspan x="262.2" y="97.8">한</tspan><tspan x="262.2" y="114.0">주</tspan><tspan x="262.2" y="125.5">식</tspan><tspan x="262.2" y="141.8">투</tspan><tspan x="262.2" y="153.2">자</tspan></text>
<text font-size="4.6" font-weight="500" fill="#F1F1EF" opacity=".9" text-anchor="middle"><tspan x="262.2" y="266.8">이</tspan><tspan x="262.2" y="271.7">광</tspan><tspan x="262.2" y="276.6">수</tspan><tspan x="262.2" y="283.5">지</tspan><tspan x="262.2" y="288.4">음</tspan></text>
<rect x="249.3" y="32.8" width="25.7" height="263.3" rx="1.2" fill="url(#bsCurve)"/>
<rect x="249.3" y="32.8" width="25.7" height="263.3" rx="1.2" fill="url(#bsVert)"/>
</g>
<g clip-path="url(#bsClip6)">
<rect x="275.0" y="50.3" width="30.4" height="245.7" rx="1.2" fill="#1E3A52"/>
<rect x="275.0" y="270.3" width="30.4" height="25.7" rx="1.2" fill="#F2ECC0"/>
<text font-size="12.8" font-weight="700" fill="#EDEBE3" text-anchor="middle"><tspan x="290.3" y="66.9">내</tspan><tspan x="290.3" y="80.4">면</tspan><tspan x="290.3" y="99.6">근</tspan><tspan x="290.3" y="113.2">력</tspan></text>
<text transform="translate(292.0 121.6) rotate(90)" font-size="4.8" font-weight="500" fill="#EDEBE3" opacity=".72" letter-spacing="1">INNER EXCELLENCE</text>
<text font-size="4.3" font-weight="400" fill="#EDEBE3" opacity=".7" text-anchor="middle"><tspan x="290.3" y="257.4">윌</tspan><tspan x="290.3" y="261.9">북</tspan></text>
<text font-size="4.6" font-weight="500" fill="#EDEBE3" opacity=".9" text-anchor="middle"><tspan x="290.3" y="235.2">짐</tspan><tspan x="290.3" y="242.1">머</tspan><tspan x="290.3" y="247.0">피</tspan></text>
<rect x="275.0" y="50.3" width="30.4" height="245.7" rx="1.2" fill="url(#bsCurve)"/>
<rect x="275.0" y="50.3" width="30.4" height="245.7" rx="1.2" fill="url(#bsVert)"/>
</g>
<g transform="rotate(-0.3 319.5 296)" clip-path="url(#bsClip7)">
<rect x="305.5" y="67.9" width="28.1" height="228.1" rx="1.2" fill="#DEE9F1"/>
<text font-size="11.8" font-weight="700" fill="#2C4A66" text-anchor="middle"><tspan x="319.5" y="83.1">윤</tspan><tspan x="319.5" y="95.6">슬</tspan><tspan x="319.5" y="108.1">의</tspan><tspan x="319.5" y="125.9">바</tspan><tspan x="319.5" y="138.4">다</tspan></text>
<rect x="305.5" y="67.9" width="28.1" height="228.1" rx="1.2" fill="url(#bsCurve)"/>
<rect x="305.5" y="67.9" width="28.1" height="228.1" rx="1.2" fill="url(#bsVert)"/>
</g>
<g transform="rotate(-0.55 346.4 296)" clip-path="url(#bsClip8)">
<rect x="333.5" y="73.7" width="25.7" height="222.3" rx="1.2" fill="#F2EFE9"/>
<text font-size="10.8" font-weight="700" fill="#1C2733" text-anchor="middle"><tspan x="346.4" y="88.1">수</tspan><tspan x="346.4" y="99.5">족</tspan><tspan x="346.4" y="111.0">관</tspan></text>
<text font-size="4.6" font-weight="500" fill="#1C2733" opacity=".9" text-anchor="middle"><tspan x="346.4" y="257.1">유</tspan><tspan x="346.4" y="262.0">래</tspan><tspan x="346.4" y="266.8">혁</tspan><tspan x="346.4" y="273.8">장</tspan><tspan x="346.4" y="278.6">편</tspan><tspan x="346.4" y="283.5">소</tspan><tspan x="346.4" y="288.4">설</tspan></text>
<rect x="333.5" y="73.7" width="25.7" height="222.3" rx="1.2" fill="url(#bsCurve)"/>
<rect x="333.5" y="73.7" width="25.7" height="222.3" rx="1.2" fill="url(#bsVert)"/>
</g>
<g transform="rotate(-0.4 371.0 296)" clip-path="url(#bsClip9)">
<rect x="359.3" y="76.0" width="23.4" height="220.0" rx="1.2" fill="#BFE0F0"/>
<rect x="359.3" y="265.6" width="23.4" height="30.4" rx="1.2" fill="#4E8FBF"/>
<text font-size="9.8" font-weight="700" fill="#123A5C" text-anchor="middle"><tspan x="371.0" y="89.6">시</tspan><tspan x="371.0" y="100.0">한</tspan><tspan x="371.0" y="110.4">부</tspan></text>
<text font-size="4.6" font-weight="500" fill="#123A5C" opacity=".9" text-anchor="middle"><tspan x="371.0" y="226.7">백</tspan><tspan x="371.0" y="231.5">은</tspan><tspan x="371.0" y="236.4">별</tspan><tspan x="371.0" y="243.3">장</tspan><tspan x="371.0" y="248.2">편</tspan><tspan x="371.0" y="253.1">소</tspan><tspan x="371.0" y="258.0">설</tspan></text>
<rect x="359.3" y="76.0" width="23.4" height="220.0" rx="1.2" fill="url(#bsCurve)"/>
<rect x="359.3" y="76.0" width="23.4" height="220.0" rx="1.2" fill="url(#bsVert)"/>
</g>
<g transform="rotate(-0.8 393.2 296)" clip-path="url(#bsClip10)">
<rect x="382.7" y="76.0" width="21.1" height="220.0" rx="1.2" fill="#8E1B2E"/>
<text font-size="8.8" font-weight="700" fill="#F3EAE7" text-anchor="middle"><tspan x="393.2" y="88.8">나</tspan><tspan x="393.2" y="98.2">의</tspan><tspan x="393.2" y="111.5">사</tspan><tspan x="393.2" y="120.9">탄</tspan></text>
<text font-size="4.3" font-weight="400" fill="#F3EAE7" opacity=".7" text-anchor="middle"><tspan x="393.2" y="270.2">w</tspan><tspan x="393.2" y="274.8">e</tspan><tspan x="393.2" y="279.4">f</tspan><tspan x="393.2" y="283.9">i</tspan><tspan x="393.2" y="288.5">c</tspan></text>
<rect x="382.7" y="76.0" width="21.1" height="220.0" rx="1.2" fill="url(#bsCurve)"/>
<rect x="382.7" y="76.0" width="21.1" height="220.0" rx="1.2" fill="url(#bsVert)"/>
</g>
</svg>`;

/** Web sizing at ≤860px: max 320 wide × 210 tall, centered, 32px below. */
export const HeroShelf = memo(function HeroShelf({ width }: { width: number }) {
  const w = Math.min(320, Math.max(0, width));
  const h = Math.min(210, (w * 340) / 460);
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: w, height: h, alignSelf: 'center' }}>
    <SvgXml xml={SHELF} width="100%" height="100%" />
  </View>;
});
